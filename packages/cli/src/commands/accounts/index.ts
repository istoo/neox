import { readFile, stat } from "node:fs/promises";
import { Command } from "commander";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@neolix/protocol/messages";
import { windowsFromReports } from "@neolix/server/gateway-accounts";
import { connectToDaemon, tryConnectToDaemon } from "../../utils/client.js";
import { toCommandError } from "../../output/index.js";
import {
  addLocalDaemonOptions,
  globalDaemonSelectors,
  withGlobalOptions,
} from "../../utils/command-options.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";
import type { ConnectOptions } from "../../utils/client.js";
import {
  accountDisplayName,
  addFactoryAccount,
  aliasAccount,
  formatAccountRow,
  getDiscovery,
  importAccounts,
  importClaudeAccounts,
  importClaudeSignIn,
  listAccounts,
  parseAccountAgent,
  refreshAccounts,
  removeAccount,
  setAccountProject,
  setDiscovery,
  switchAccount,
  type AccountsOptions,
} from "./accounts.js";
import {
  checkinViaDaemon,
  listAccountsViaDaemon,
  listPluginSubscriptionsViaDaemon,
  pluginSubscriptionModelsViaDaemon,
  pluginSubscriptionSignInPollViaDaemon,
  pluginSubscriptionSignInViaDaemon,
  removeAccountViaDaemon,
  type CheckinEntry,
} from "./accounts-rpc.js";
import { withGatewayStore } from "../provider/gateway-store.js";
import {
  parseOnOff,
  parseSwitchOnlyAgent,
  setSwitchOnly,
  switchOnlyOf,
  switchOnlySaid,
  switchOnlyWritten,
} from "./switch-only.js";

/**
 * `neolix accounts` — myna's `internal/cli/accounts_cli.go` tree: the
 * subscriptions Neolix signed in to itself, their allowances' accounts, and
 * the imports and refreshes that keep them. The list and removal ask the
 * daemon first, because it writes the same stores; the rest reads and
 * writes `$NEOLIX_HOME/gateway/` directly. Signing a new one in asks the
 * daemon, whose RPC runs the browser flow.
 */

interface GlobalOptions {
  home?: string;
  format?: string;
  json?: boolean;
  daemonTarget?: ConnectOptions["target"];
}

interface AccountAddOptions extends GlobalOptions {
  host?: string;
  /** Factory's key; the agent that signs in by key rather than a browser. */
  key?: string;
}

const SIGN_IN_POLL_MS = 1000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function wantsJson(options: GlobalOptions): boolean {
  return options.json === true || options.format === "json";
}

function fail(error: unknown): void {
  // Connection failures arrive as { code, message } objects; String() would
  // print "[object Object]" (accounts add copilot --host ...).
  process.stderr.write(`${toCommandError(error).message}\n`);
  process.exitCode = 1;
}

/**
 * The daemon's usage sources, as the windows `accounts switch
 * <codex|claude> next` picks the account with room from. Without a daemon
 * no allowance is known and the command asks for the account by name, as
 * myna does when it has no reading.
 */
async function accountUsageWindows(
  options: GlobalOptions,
  agent: Parameters<typeof switchAccount>[1],
  ref: string,
): Promise<AccountsOptions["usageWindows"]> {
  if (ref.trim().toLowerCase() !== "next" || (agent !== "codex" && agent !== "claude")) {
    return undefined;
  }
  const target = options.daemonTarget;
  if (target === undefined) {
    return undefined;
  }
  const client = await tryConnectToDaemon({ target, timeout: 1500 });
  if (client === null) {
    return undefined;
  }
  try {
    const { reports } = await client.listUsageReports();
    return (family, account) => {
      const windows = windowsFromReports(reports, family, {
        id: account.id,
        label: account.user,
      });
      return windows?.flatMap((window) =>
        window.usedPct === null
          ? []
          : [{ usedPercent: window.usedPct, resetAt: window.resetsAt, name: window.id }],
      );
    };
  } catch {
    return undefined;
  } finally {
    await client.close().catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readExport(path: string): Promise<string> {
  // A file that can't be read stops the import: what it holds isn't known,
  // so it isn't taken for a file with nothing in it (`accounts_cli.go:598-613`).
  const info = await stat(path);
  if (info.size > 4 * 1024 * 1024) {
    throw new Error(`${path} is too big to be an export`);
  }
  return readFile(path, "utf8");
}

async function confirmImport(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("import canceled: pass --yes to import without a terminal to answer in");
  }
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("Import? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function addAccount(agentRef: string, options: AccountAddOptions): Promise<void> {
  const agent = parseAccountAgent(agentRef);
  if (agent === "factory") {
    const key = (options.key ?? "").trim();
    if (key === "") {
      throw new Error("pass the account's Factory API key: --key fk-…");
    }
    const added = await addFactoryAccount(options as AccountsOptions, key);
    print(`✓ added ${added.user}`);
    return;
  }
  const site =
    agent === "copilot" && options.host !== undefined && options.host.trim() !== ""
      ? options.host.trim()
      : undefined;
  if (options.daemonTarget === undefined) {
    throw new Error("no daemon target selected");
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.gatewaySignin !== true) {
      throw new Error("Update the host to sign in a subscription from the CLI.");
    }
    const started = await client.startGatewaySignIn({
      agent,
      ...(site === undefined ? {} : { site }),
    });
    announceSignIn(started.state);
    const state = await waitForSignIn(client, started.state);
    if (state.state === "done") {
      print(
        `✓ added ${state.user ?? ""}${state.again === true ? " (its sign-in was renewed)" : ""}`,
      );
      return;
    }
    if (state.state === "failed" || state.state === "canceled") {
      throw new Error(state.error ?? "sign-in didn't finish");
    }
    await client.cancelGatewaySignIn(state.id).catch(() => false);
    throw new Error("sign-in timed out");
  } finally {
    await client.close().catch(() => undefined);
  }
}

type SignInState = Extract<
  SessionOutboundMessage,
  { type: "gateway.signin.status.response" }
>["payload"]["state"];

/** What the user has to do now, as myna's add prints it. */
function announceSignIn(state: SignInState): void {
  if (state.url !== undefined && state.url !== "") {
    print(`Open ${state.url}`);
  }
  if (state.code !== undefined) {
    print(`Enter the code ${state.code}`);
  }
  if (state.pasteCallback === true) {
    print(
      "If the page won't load (the host is remote or in Docker), paste its address in the app.",
    );
  }
}

/** Follows a waiting sign-in until it is over, or ten minutes have passed. */
async function waitForSignIn(client: DaemonClient, started: SignInState): Promise<SignInState> {
  let state = started;
  let askedCallback = false;
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  while (state.state === "waiting" && Date.now() < deadline) {
    await sleep(SIGN_IN_POLL_MS);
    state = (await client.getGatewaySignIn(state.id)).state;
    if (!shouldPaste(state, askedCallback)) {
      continue;
    }
    askedCallback = true;
    if (!(await pasteCallback(client, state.id))) {
      await client.cancelGatewaySignIn(state.id).catch(() => false);
      throw new Error("sign-in didn't finish");
    }
  }
  return state;
}

/** The callback port couldn't be opened here, so the address has to be handed back by hand. */
function shouldPaste(state: SignInState, asked: boolean): boolean {
  return (
    !asked &&
    process.stdin.isTTY &&
    state.state === "waiting" &&
    state.pasteCallback === true &&
    state.callbackBlocked !== undefined
  );
}

/** Hands the daemon the address a browser ended on, when it couldn't reach this computer. */
async function pasteCallback(client: DaemonClient, id: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    print("If the page won't load (the host is remote or in Docker), copy its whole address.");
    const url = (await readline.question("Paste it here: ")).trim();
    if (url === "") {
      return false;
    }
    const result = await client.callbackGatewaySignIn(id, url);
    if (!result.ok) {
      fail(new Error(result.error ?? "sign-in didn't finish"));
      return false;
    }
    return true;
  } finally {
    readline.close();
  }
}

/** What `neolix accounts [agent]` lists: the four subscriptions, and Claude's saved sign-ins. */
function parseListAgent(name: string | undefined): Parameters<typeof listAccounts>[1] | undefined {
  if (name === undefined) {
    return undefined;
  }
  return name.trim().toLowerCase() === "claude" ? "claude" : parseAccountAgent(name);
}

/** The agents `accounts switch` can move, including Codex's and Claude's own sign-in. */
function parseSwitchAgent(name: string): Parameters<typeof switchAccount>[1] {
  const lower = name.trim().toLowerCase();
  return lower === "codex" || lower === "claude" ? lower : parseAccountAgent(name);
}

/** The agents `accounts import` reads exports for, as myna's `agentID`. */
function parseImportAgent(name: string): "codex" | "claude" | "antigravity" | "factory" {
  switch (name.trim().toLowerCase()) {
    case "codex":
    case "chatgpt":
      return "codex";
    case "claude":
    case "cc":
      return "claude";
    case "antigravity":
    case "ag":
      return "antigravity";
    case "factory":
    case "droid":
      return "factory";
  }
  throw new Error(`"${name}": accounts can be imported for codex, claude and antigravity`);
}

/**
 * Codex and codexbar exports, read here and handed to the daemon's own
 * importer (`gateway.codex.account.import`): the daemon refreshes each
 * sign-in with ChatGPT and writes the account store it serves from.
 */
async function runCodexImport(paths: readonly string[], options: ImportOptions): Promise<void> {
  if (paths.length === 0 && options.fromCodex !== true) {
    throw new Error("name a file to import, or pass --from-codex");
  }
  print(
    "! Each account's sign-in is refreshed with ChatGPT before it is added, as signing in does.",
  );
  print(
    "! That spends the file's sign-in: the tool it came from is signed out of that account and has to sign in again. From then on the account is Neox's.",
  );
  print(
    "! The files are only read, never changed. An account Neox holds already is left as it is.",
  );
  if (options.yes !== true && !(await confirmImport())) {
    throw new Error("import canceled");
  }
  if (options.daemonTarget === undefined) {
    throw new Error("no daemon target selected");
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.gatewayCodexStatus !== true) {
      throw new Error("Update the host to import ChatGPT accounts from the CLI.");
    }
    let added = 0;
    let updated = 0;
    const failed: { file: string; error: string }[] = [];
    if (options.fromCodex === true) {
      const result = await client.importGatewayCodexAccounts({ fromCodex: true });
      added += result.added;
      updated += result.updated;
      failed.push(...result.failed);
    }
    for (const path of paths) {
      const text = await readExport(path);
      const result = await client.importGatewayCodexAccounts({ text });
      added += result.added;
      updated += result.updated;
      for (const entry of result.failed) {
        failed.push({ file: path, error: entry.error });
      }
    }
    if (wantsJson(options)) {
      printJson({ added, updated, failed });
      return;
    }
    if (added > 0) {
      print(`✓ added ${added}`);
    }
    if (updated > 0) {
      print(`✓ ${updated} · in Neox already, now with this sign-in`);
    }
    for (const entry of failed) {
      print(`✗ ${entry.file}: ${entry.error}`);
    }
    if (added === 0 && updated === 0) {
      print("nothing imported");
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

type ImportOptions = GlobalOptions & { yes?: boolean; fromCodex?: boolean; fromClaude?: boolean };

/**
 * Claude Code's own `.credentials.json` and other tools' exports for it.
 * myna keeps each account as its file has it and never refreshes it
 * (`login_import.go`); nothing is written to Claude Code's store here.
 */
async function runClaudeImport(paths: readonly string[], options: ImportOptions): Promise<void> {
  if (paths.length === 0 && options.fromClaude !== true) {
    throw new Error("name a file to import, or pass --from-claude");
  }
  print(
    "! Each account is kept as the file has it. Claude Code renews its sign-in the first time it uses it, and the file's copy then stops working: the tool it came from has to sign in again.",
  );
  print("! The files are only read, never changed.");
  if (options.yes !== true && !(await confirmImport())) {
    throw new Error("import canceled");
  }
  if (paths.length === 0) {
    const result = await importClaudeSignIn(options as AccountsOptions);
    if (wantsJson(options)) {
      printJson([result]);
    } else if (result.status === "failed") {
      print(`✗ this computer: ${result.error ?? "not added"}`);
    } else {
      print(
        result.status === "added"
          ? `✓ added ${result.user} (this computer)`
          : `✓ ${result.user} · in Neox already, now with this sign-in`,
      );
    }
    if (result.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }
  const texts: string[] = [];
  for (const path of paths) {
    texts.push(await readExport(path));
  }
  const results = await importClaudeAccounts(options as AccountsOptions, texts);
  if (wantsJson(options)) {
    printJson(results);
  } else {
    for (const result of results) {
      const who = result.file > 0 ? (paths[result.file - 1] ?? result.user) : result.user;
      switch (result.status) {
        case "added":
          print(`✓ added ${result.user} (${who})`);
          break;
        case "updated":
          print(`✓ ${result.user} · in Neox already, now with this sign-in`);
          break;
        default:
          print(`✗ ${who}: ${result.error ?? "not added"}`);
      }
    }
  }
  if (results.every((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

async function runImport(
  agentRef: string,
  paths: readonly string[],
  options: ImportOptions,
): Promise<void> {
  const agent = parseImportAgent(agentRef);
  if (agent === "factory") {
    // myna sends Factory's keys to the plugin's own add; Neolix keeps the
    // same way in: the key is signed in, not read from a file.
    throw new Error(
      "Factory accounts are added by their API key: neox accounts add factory --key fk-…",
    );
  }
  if (agent === "codex") {
    await runCodexImport(paths, options);
    return;
  }
  if (agent === "claude") {
    await runClaudeImport(paths, options);
    return;
  }
  if (paths.length === 0) {
    throw new Error("name a file to import");
  }
  print(
    "! Google may suspend an Antigravity account it sees used outside Antigravity. Use one you can afford to lose.",
  );
  print("! Each account's sign-in is refreshed with Google before it is added.");
  if (options.yes !== true && !(await confirmImport())) {
    throw new Error("import canceled");
  }
  const texts: string[] = [];
  for (const path of paths) {
    texts.push(await readExport(path));
  }
  const results = await importAccounts(options as AccountsOptions, agent, texts);
  if (wantsJson(options)) {
    printJson(results);
  } else {
    for (const result of results) {
      const who =
        result.file !== undefined && result.file > 0
          ? (paths[result.file - 1] ?? result.user)
          : result.user;
      switch (result.status) {
        case "added":
          print(`✓ added ${who}${result.plan === undefined ? "" : ` · ${result.plan}`}`);
          break;
        case "updated":
          print(`✓ ${who} · in Neox already, now with this sign-in`);
          break;
        case "exists":
          print(`= ${who} · in Neox already with this sign-in, left as it is`);
          break;
        default:
          print(`✗ ${who}: ${result.error ?? "not added"}`);
      }
    }
  }
  if (results.every((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

async function runRefresh(options: GlobalOptions): Promise<void> {
  const rows = await refreshAccounts(options as AccountsOptions);
  if (wantsJson(options)) {
    printJson(rows);
    return;
  }
  if (rows.length === 0) {
    print("no accounts yet · add one: neox accounts add <agent>");
    return;
  }
  for (const row of rows) {
    const who = `${row.agent.padEnd(12)} ${row.user}`;
    if (row.error !== undefined) {
      print(`✗ ${who} · ${row.error}`);
    } else if (row.refreshed) {
      print(`✓ ${who} · renewed`);
    } else {
      print(`= ${who} · no renewal needed`);
    }
  }
  if (rows.some((row) => row.error !== undefined)) {
    process.exitCode = 1;
  }
}

async function runRemove(agentRef: string, ref: string, options: GlobalOptions): Promise<void> {
  const agent = parseAccountAgent(agentRef);
  const viaDaemon =
    options.daemonTarget === undefined
      ? undefined
      : await removeAccountViaDaemon({ target: options.daemonTarget }, agent, ref);
  if (viaDaemon === true) {
    print(`✓ removed ${ref} from ${agent}`);
    return;
  }
  if (viaDaemon === false) {
    throw new Error(`no account "${ref}" — neox accounts lists them`);
  }
  const result = await removeAccount(options as AccountsOptions, agent, ref);
  print(`✓ removed ${result.user} from ${agent}`);
}

export function createAccountsCommand(): Command {
  const accounts = new Command("accounts").description(
    "The subscriptions Neox signed in to itself",
  );
  addLocalDaemonOptions(accounts);

  addLocalDaemonOptions(
    accounts
      .command("add")
      .description("Sign in a subscription account (Factory by its API key)")
      .argument("<agent>", "chatgpt, copilot, gemini, antigravity or factory")
      .option("--host <host>", "A Copilot account's enterprise host (<name>.ghe.com)")
      .option("--key <key>", "A Factory API key (fk-…)"),
  ).action(async (agentRef: string, options: AccountAddOptions, command: Command) => {
    try {
      // `accounts add --host` is myna's Copilot enterprise host
      // (internal/cli/accounts_cli.go:131-147), not the daemon endpoint this
      // local command never takes; the home still selects the daemon's files.
      const merged = { ...options, ...(command.optsWithGlobals() as AccountAddOptions) };
      merged.daemonTarget = selectDaemonTarget(
        { home: globalDaemonSelectors(command).home },
        process.env,
        true,
      );
      await addAccount(agentRef, merged);
    } catch (error) {
      fail(error);
    }
  });

  addLocalDaemonOptions(
    accounts
      .command("import")
      .description("Bring in accounts from another tool's export")
      .argument("<agent>", "codex, claude or antigravity")
      .argument("[files...]", "Exports to read; JSON, or refresh tokens one a line")
      .option("-y, --yes", "Import without asking")
      .option("--from-codex", "Import the sign-in Codex keeps on this computer")
      .option("--from-claude", "Import the sign-in Claude Code keeps on this computer"),
  ).action(
    withGlobalOptions(async (agentRef: string, paths: string[], options: ImportOptions) => {
      try {
        await runImport(agentRef, paths, options);
      } catch (error) {
        fail(error);
      }
    }),
  );

  addLocalDaemonOptions(
    accounts.command("refresh").description("Renew every account's sign-in"),
  ).action(
    withGlobalOptions(async (options: GlobalOptions) => {
      try {
        await runRefresh(options);
      } catch (error) {
        fail(error);
      }
    }),
  );

  addLocalDaemonOptions(
    accounts
      .command("project")
      .description("Bind a Gemini or Antigravity account to a Google Cloud project")
      .argument("<agent>", "gemini or antigravity")
      .argument("<email>", "The account's user, id or alias")
      .argument("<project>", 'A Google Cloud project id, or "" to clear it'),
  ).action(
    withGlobalOptions(
      async (agentRef: string, ref: string, project: string, options: GlobalOptions) => {
        try {
          const agent = parseAccountAgent(agentRef);
          const result = await setAccountProject(options as AccountsOptions, agent, ref, project);
          print(
            result.project === ""
              ? `✓ ${result.user} no longer names a Google Cloud project`
              : `✓ ${result.user} now uses Google Cloud project ${result.project}`,
          );
        } catch (error) {
          fail(error);
        }
      },
    ),
  );

  addLocalDaemonOptions(
    accounts
      .command("alias")
      .description("Name an account, for the CLI and the app")
      .argument("<agent>", "The account's agent")
      .argument("<email>", "The account's user or id")
      .argument("[name]", "The name to give it, or --clear"),
  ).action(
    withGlobalOptions(
      async (agentRef: string, ref: string, name: string | undefined, options: GlobalOptions) => {
        try {
          const agent = parseAccountAgent(agentRef);
          const result = await aliasAccount(options as AccountsOptions, agent, ref, name);
          print(
            result.alias === ""
              ? `✓ ${result.user} no longer has a name of its own`
              : `✓ ${result.user} is now named ${result.alias}`,
          );
        } catch (error) {
          fail(error);
        }
      },
    ),
  );

  addLocalDaemonOptions(
    accounts
      .command("switch")
      .description("Use one account for the gateway providers signed in to this agent")
      .argument("<agent>", "The account's agent")
      .argument("<email>", "The account's user, id or alias, or next"),
  ).action(
    withGlobalOptions(async (agentRef: string, ref: string, options: GlobalOptions) => {
      try {
        const agent = parseSwitchAgent(agentRef);
        const usageWindows = await accountUsageWindows(options, agent, ref);
        const result = await switchAccount(
          { ...(options as AccountsOptions), usageWindows },
          agent,
          ref,
        );
        if (result.over === true) {
          print(`every other account is past its line; ${result.user} has the most room left`);
        }
        if (result.agent === "codex") {
          let where = "";
          if (result.store === "keychain") {
            where = " (written to Codex's keychain item)";
          } else if (result.store === "file") {
            where = " (written to ~/.codex/auth.json)";
          }
          print(`✓ Codex now signs in as ${result.user}${where}`);
        } else if (result.agent === "claude") {
          const where =
            result.store === "keychain"
              ? " (written to Claude Code's keychain item)"
              : " (written to ~/.claude/.credentials.json)";
          print(`✓ Claude Code now signs in as ${result.user}${where}`);
        } else {
          print(`✓ Neox now uses ${result.user} for ${agent}`);
        }
      } catch (error) {
        fail(error);
      }
    }),
  );

  addLocalDaemonOptions(
    accounts
      .command("remove")
      .description("Forget an account Neox signed in to itself")
      .argument("<agent>", "The account's agent")
      .argument("<email>", "The account's user, id or alias"),
  ).action(
    withGlobalOptions(async (agentRef: string, ref: string, options: GlobalOptions) => {
      try {
        await runRemove(agentRef, ref, options);
      } catch (error) {
        fail(error);
      }
    }),
  );

  addLocalDaemonOptions(
    accounts
      .command("discovery")
      .description("Whether Neox reads the agents' own sign-ins")
      .argument("[on|off]"),
  ).action(
    withGlobalOptions(async (value: string | undefined, options: GlobalOptions) => {
      try {
        const wanted = value?.trim().toLowerCase();
        if (wanted === undefined || wanted === "") {
          print((await getDiscovery(options as AccountsOptions)) ? "on" : "off");
          return;
        }
        if (wanted !== "on" && wanted !== "off") {
          throw new Error(`"${value}": on or off`);
        }
        const on = await setDiscovery(options as AccountsOptions, wanted === "on");
        print(on ? "on" : "off");
      } catch (error) {
        fail(error);
      }
    }),
  );

  // myna's `accounts switch-only`: neolix only moves the agent's own sign-in.
  addLocalDaemonOptions(
    accounts
      .command("switch-only")
      .description("Only switch the agent's own sign-in; serve no requests on it")
      .argument("<agent>", "codex or claude")
      .argument("[on|off]"),
  ).action(async function (this: Command, agentRef: string, value: string | undefined) {
    try {
      const options = this.optsWithGlobals() as GlobalOptions;
      const id = parseSwitchOnlyAgent(agentRef);
      const on = value === undefined ? undefined : parseOnOff(value);
      await withGatewayStore({ home: options.home }, async (store) => {
        const config = store.get();
        if (on === undefined) {
          print(switchOnlySaid(id, switchOnlyOf(config, id)));
          return;
        }
        const next = setSwitchOnly(config, id, on);
        await store.write(next);
        print(`✓ ${switchOnlyWritten(id, on)}`);
      });
    } catch (error) {
      fail(error);
    }
  });

  accounts
    .argument("[agent]", "One agent's accounts: chatgpt, copilot, gemini or antigravity")
    .action(
      withGlobalOptions(async (agentRef: string | undefined, options: GlobalOptions) => {
        try {
          const agent = parseListAgent(agentRef);
          const rows =
            agent === "claude"
              ? await listAccounts(options as AccountsOptions, "claude")
              : ((options.daemonTarget === undefined
                  ? undefined
                  : await listAccountsViaDaemon({ target: options.daemonTarget }, agent)) ??
                (await listAccounts(options as AccountsOptions, agent)));
          if (wantsJson(options)) {
            printJson(rows);
            return;
          }
          if (rows.length === 0) {
            print("no accounts yet · add one: neox accounts add <agent>");
            return;
          }
          for (const row of rows) {
            print(formatAccountRow(row));
          }
          print(
            "  add one: neox accounts add <agent> · switch: neox accounts switch <agent> <email>",
          );
        } catch (error) {
          fail(error);
        }
      }),
    );

  accounts
    .command("checkin")
    .description("Check the signed-in accounts in for today (myna's accounts checkin)")
    .option("--by <vendor>", "one vendor's accounts: workbuddy, minimax, trae or qoder")
    .option("--account <key>", "one account, even while left out of the daily check-in")
    .action(
      withGlobalOptions(async (options: GlobalOptions & { by?: string; account?: string }) => {
        try {
          const target = options.daemonTarget;
          if (target === undefined) {
            fail(new Error("no daemon selected · pass --host <host> or start the local one"));
            return;
          }
          const entries = await checkinViaDaemon(
            { target },
            {
              ...(options.by === undefined ? {} : { by: options.by }),
              ...(options.account === undefined ? {} : { key: options.account }),
            },
          );
          if (entries === undefined) {
            fail(
              new Error(
                "the daemon didn't answer, or is too old to know check-ins · start it with `neox daemon start`",
              ),
            );
            return;
          }
          if (wantsJson(options)) {
            printJson(entries);
            return;
          }
          if (entries.length === 0) {
            print(
              "no check-in account · sign in to WorkBuddy, MiniMax Code, Trae CN or Qoder in myna first",
            );
            return;
          }
          for (const entry of entries) {
            print(`${entry.user} · ${checkinVendorName(entry.by)} · ${checkinSaid(entry)}`);
          }
        } catch (error) {
          fail(error);
        }
      }),
    );

  accounts
    .command("subscriptions")
    .description("List running plugins' subscription providers and sign in to one")
    .option("--models <plugin/provider>", "an account's models from this provider")
    .option("--sign-in <plugin/provider>", "run this provider's sign-in")
    .option("--method <n>", "which sign-in method to run (from the list)")
    .option("--account <id>", "the account id the sign-in is kept under")
    .option("--input <key=value>", "a sign-in prompt's value (repeatable)", collectInputs, [])
    .action(
      withGlobalOptions(async (options: SubscriptionCommandOptions) => {
        try {
          await runSubscriptions(options);
        } catch (error) {
          fail(error);
        }
      }),
    );

  return accounts;
}

interface SubscriptionCommandOptions extends GlobalOptions {
  models?: string;
  signIn?: string;
  method?: string;
  account?: string;
  input: string[];
}

type SubscriptionTarget = NonNullable<SubscriptionCommandOptions["daemonTarget"]>;

const DAEMON_WITHOUT_SUBSCRIPTIONS =
  "the daemon didn't answer, or is too old to know plugin subscriptions";

async function runSubscriptions(options: SubscriptionCommandOptions): Promise<void> {
  const target = options.daemonTarget;
  if (target === undefined) {
    throw new Error("no daemon selected · pass --host <host> or start the local one");
  }
  if (options.signIn !== undefined) {
    await signInSubscription(options, target);
    return;
  }
  if (options.models !== undefined) {
    await listSubscriptionModels(options, target);
    return;
  }
  await listSubscriptions(options, target);
}

function subscriptionRef(ref: string, option: string): { pluginId: string; providerId: string } {
  const parsed = parseSubscriptionRef(ref);
  if (parsed === undefined) throw new Error(`${option} needs <plugin>/<provider>`);
  return parsed;
}

function subscriptionAccount(options: SubscriptionCommandOptions): string {
  if (options.account === undefined || options.account === "") {
    throw new Error("--account <id> names the account the sign-in is kept under");
  }
  return options.account;
}

async function signInSubscription(
  options: SubscriptionCommandOptions,
  target: SubscriptionTarget,
): Promise<void> {
  const ref = subscriptionRef(options.signIn ?? "", "--sign-in");
  const accountId = subscriptionAccount(options);
  const method = Number(options.method ?? "0");
  if (!Number.isInteger(method) || method < 0) {
    throw new Error("--method must be a sign-in method's number");
  }
  const answer = await pluginSubscriptionSignInViaDaemon(
    { target },
    {
      pluginId: ref.pluginId,
      providerId: ref.providerId,
      method,
      accountId,
      inputs: inputsOf(options.input),
    },
  );
  if (answer === undefined) throw new Error(DAEMON_WITHOUT_SUBSCRIPTIONS);
  if (answer.status === "pending") {
    await finishPendingSignIn(options, target, ref, accountId, answer);
    return;
  }
  reportSubscriptionSignedIn(options, ref, accountId, answer.auth);
}

function reportSubscriptionSignedIn(
  options: SubscriptionCommandOptions,
  ref: { pluginId: string; providerId: string },
  accountId: string,
  auth: Record<string, unknown> | undefined,
): void {
  if (wantsJson(options)) {
    printJson(auth ?? {});
    return;
  }
  print(`signed in · ${ref.pluginId}/${ref.providerId} · ${accountId}`);
}

async function finishPendingSignIn(
  options: SubscriptionCommandOptions,
  target: SubscriptionTarget,
  ref: { pluginId: string; providerId: string },
  accountId: string,
  answer: {
    url?: string;
    instructions?: string;
    token?: string;
  },
): Promise<void> {
  if (!wantsJson(options)) {
    if (answer.url !== undefined) print(`open · ${answer.url}`);
    if (answer.instructions !== undefined) print(answer.instructions);
  }
  if (answer.token === undefined) {
    throw new Error("the sign-in is pending but has no token to poll");
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const poll = await pluginSubscriptionSignInPollViaDaemon(
      { target },
      { pluginId: ref.pluginId, providerId: ref.providerId, token: answer.token },
    );
    if (poll === undefined) throw new Error(DAEMON_WITHOUT_SUBSCRIPTIONS);
    if (poll.status === "signed_in") {
      reportSubscriptionSignedIn(options, ref, accountId, poll.auth);
      return;
    }
  }
  throw new Error("the sign-in was not authorized in 10 minutes");
}

async function listSubscriptionModels(
  options: SubscriptionCommandOptions,
  target: SubscriptionTarget,
): Promise<void> {
  const ref = subscriptionRef(options.models ?? "", "--models");
  const answer = await pluginSubscriptionModelsViaDaemon(
    { target },
    {
      pluginId: ref.pluginId,
      providerId: ref.providerId,
      accountId: subscriptionAccount(options),
    },
  );
  if (answer === undefined) throw new Error(DAEMON_WITHOUT_SUBSCRIPTIONS);
  if (wantsJson(options)) {
    printJson(answer.models);
    return;
  }
  for (const model of answer.models) {
    print(`${model.id}${model.name === undefined ? "" : ` · ${model.name}`}`);
  }
}

async function listSubscriptions(
  options: SubscriptionCommandOptions,
  target: SubscriptionTarget,
): Promise<void> {
  const answer = await listPluginSubscriptionsViaDaemon({ target });
  if (answer === undefined) throw new Error(DAEMON_WITHOUT_SUBSCRIPTIONS);
  if (wantsJson(options)) {
    printJson(answer.providers);
    return;
  }
  if (answer.providers.length === 0) {
    print("no plugin subscription provider · install a plugin that declares one first");
    return;
  }
  for (const provider of answer.providers) {
    const methods = provider.methods.map((method) => method.label).join(", ");
    print(
      `${provider.label} · ${provider.pluginId}/${provider.id} · ${provider.protocol} · ${methods}`,
    );
  }
}

/** One `--input key=value` pair. */
function collectInputs(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** A `<plugin>/<provider>` pair, or undefined when either half is empty. */
function parseSubscriptionRef(ref: string): { pluginId: string; providerId: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { pluginId: ref.slice(0, slash), providerId: ref.slice(slash + 1) };
}

/** The sign-in prompts' values, split at the first `=`. */
function inputsOf(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    out[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return out;
}

/** A check-in vendor's name, as myna writes it. */
function checkinVendorName(by: string): string {
  switch (by) {
    case "workbuddy":
      return "WorkBuddy";
    case "minimax":
      return "MiniMax Code";
    case "trae":
      return "Trae CN";
    case "qoder":
      return "Qoder";
    default:
      return by;
  }
}

/** What came of one account's check-in, in myna's words. */
function checkinSaid(entry: CheckinEntry): string {
  const plus = entry.credit !== undefined && entry.credit > 0 ? ` +${entry.credit}` : "";
  const days =
    entry.streak !== undefined && entry.streak > 1 ? ` · ${entry.streak}-day streak` : "";
  switch (entry.outcome) {
    case "claimed":
      return `checked in${plus}${days}`;
    case "done":
      return `already in${plus}`;
    case "ineligible":
      return entry.msg === undefined ? "not eligible" : `not eligible: ${entry.msg}`;
    case "inactive":
      return "no check-in event";
    case "captcha":
      return "needs a captcha in the app";
    case "own-app":
      return "do it in the app";
    default:
      return entry.msg === undefined ? "failed" : `failed: ${entry.msg}`;
  }
}

export { accountDisplayName };
