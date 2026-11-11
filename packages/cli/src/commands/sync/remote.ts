/* eslint-disable complexity -- myna's one decision table per action, kept together so its usage text stays beside the branch. */
import { Command } from "commander";
import {
  backendOf,
  defaultSyncConfig,
  loadState,
  loadSyncConfig,
  MANUAL_INTERVAL,
  saveSyncConfig,
  syncConfigView,
  type SyncConfig,
} from "@neolix/server/sync";
import type { SyncConfigView, SyncStatusView } from "@neolix/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { askPassphrase, askSecret } from "./secret.js";
import { localHome, textResult } from "./shared.js";

type SyncKind = "webdav" | "s3" | "github";

interface KindInfo {
  name: string;
  cmd: SyncKind;
  usage: string;
}

const KINDS: Record<SyncKind, KindInfo> = {
  webdav: {
    name: "WebDAV",
    cmd: "webdav",
    usage: `usage:
  neox webdav                           whether sync is on, where to, and how the last sync went
  neox webdav on <address> [user=…] [keys=no] [agents=no] [library=no]
                                          keep providers, settings, profiles, agents' models and the library
                                          the same on every computer through a WebDAV folder, and sync at once;
                                          asks for the password (with a user) and the passphrase
  neox webdav set k=v…                  change it: address, user, keys, agents, library (yes|no);
                                          password= and passphrase= ask for a new one
  neox webdav now                       sync now (the daemon also syncs by itself while it runs: see auto)
  neox webdav auto off|3|15|30|60       how often the daemon syncs by itself, in minutes; off: only when asked
  neox webdav restore                   make this computer's setup the server's; what is here is kept first
  neox webdav undo                      put back what the last restore replaced
  neox webdav upload                    put this computer's setup over a server file that isn't a backup
  neox webdav dismiss                   clear what the last sync said it replaced
  neox webdav off                       turn it off; the file on the server stays

  passphrase  the same on every computer: the files are sealed with it on this one, and the server
              only ever sees them sealed. Keep it: without it they can't be opened
  password    asked for, unechoed, never given on the command line. The one saved is only sent to the
              server and user it was given for: change either and it is asked for again
  keys        no: providers go without their API keys, and each computer keeps its own

  Piped in, the password (when asked) is the first line of stdin and the passphrase the next.

  e.g. neox webdav on https://dav.jianguoyun.com/dav/ user=me@example.com
       neox webdav set agents=no library=no
`,
  },
  s3: {
    name: "S3",
    cmd: "s3",
    usage: `usage:
  neox s3                               whether sync is on, where to, and how the last sync went
  neox s3 on s3://<bucket>[/<prefix>] access-key-id=… [endpoint=…] [region=…] [path-style=yes]
            [keys=no] [agents=no] [library=no]
                                          keep the setup the same through an S3-compatible bucket (AWS S3,
                                          Cloudflare R2, Backblaze B2, MinIO, a NAS…), and sync at once;
                                          asks for the secret and the passphrase
  neox s3 set k=v…                      change it: address, bucket, prefix, endpoint, region, access-key-id,
                                          path-style, keys, agents, library (yes|no); secret= and
                                          passphrase= ask for a new one
  neox s3 now                           sync now (the daemon also syncs by itself while it runs: see auto)
  neox s3 auto off|3|15|30|60           how often the daemon syncs by itself, in minutes
  neox s3 restore                       make this computer's setup the bucket's; what is here is kept first
  neox s3 undo                          put back what the last restore replaced
  neox s3 upload                        put this computer's setup over a bucket file that isn't a backup
  neox s3 dismiss                       clear what the last sync said it replaced
  neox s3 off                           turn it off; the file in the bucket stays

  endpoint    the server, https://…; none is AWS. R2: https://<account>.r2.cloudflarestorage.com
  region      none is us-east-1, or auto on R2
  path-style  yes: the bucket in the path, as MinIO and most servers of your own want
  passphrase  the same on every computer; the bucket only ever sees the sealed files
  secret      the access key's, asked for, unechoed, never given on the command line

  Piped in, the secret (when asked) is the first line of stdin and the passphrase the next.

  e.g. neox s3 on s3://my-bucket/neox endpoint=https://<account>.r2.cloudflarestorage.com access-key-id=…
`,
  },
  github: {
    name: "GitHub",
    cmd: "github",
    usage: `usage:
  neox github                           whether sync is on, where to, and how the last sync went
  neox github on github://owner/repo[/folder] [branch=…] [keys=no] [agents=no] [library=no]
                                          keep the encrypted setup in an existing GitHub repository;
                                          asks for a token and passphrase
  neox github set k=v…                  change it: address, branch, keys, agents, library (yes|no)
  neox github now                       sync now
  neox github auto off|3|15|30|60       how often the daemon syncs by itself, in minutes
  neox github restore                   make this computer's setup the repository's; what is here is kept first
  neox github undo                      put back what the last restore replaced
  neox github upload                    put this computer's setup over a repository file that isn't a backup
  neox github dismiss                   clear what the last sync said it replaced
  neox github off                       turn it off; the encrypted files and their commit history stay

  token      asked for, unechoed, and saved only for this repository. It needs Contents read and write.
             The repository must already exist and be private
  passphrase the same on every computer; GitHub only ever receives the sealed files
`,
  },
};

export function webdavCommand(): Command {
  return remoteCommand("webdav");
}

export function s3Command(): Command {
  return remoteCommand("s3");
}

export function githubCommand(): Command {
  return remoteCommand("github");
}

function remoteCommand(kind: SyncKind): Command {
  const info = KINDS[kind];
  const command = addJsonAndDaemonHostOptions(
    new Command(info.cmd)
      .description(`Keep this setup the same on every computer through ${info.name}`)
      .argument("[args...]", "on, set, now, auto, restore, undo, upload, dismiss or off"),
  );
  command.addHelpText("after", `\n${info.usage}`);
  const handler = async (args: string[], options: CommandOptions) =>
    runRemoteCommand(kind, args, options);
  command.action(withOutput<Record<string, unknown>, [string[]]>(handler));
  return command;
}

function turnOn(kind: SyncKind): string {
  if (kind === "s3") {
    return "neox s3 on s3://<bucket>[/<prefix>] access-key-id=… turns it on";
  }
  if (kind === "github") {
    return "neox github on github://<owner>/<repo>[/<folder>] turns it on";
  }
  return "neox webdav on <address> [user=…] turns it on";
}

async function runRemoteCommand(kind: SyncKind, args: string[], options: CommandOptions) {
  const action = args[0] ?? "show";
  switch (action) {
    case "show":
      return showCommand(kind, options);
    case "on":
      return setCommand(kind, args.slice(1), true, options);
    case "set":
      return setCommand(kind, args.slice(1), false, options);
    case "auto":
      return autoCommand(kind, args.slice(1), options);
    case "off":
      return offCommand(kind, options);
    case "now":
    case "restore":
    case "undo":
    case "upload":
    case "dismiss":
      return runtimeCommand(kind, action, options);
    default:
      throw new Error(`unknown action ${action}\n\n${KINDS[kind].usage}`);
  }
}

/** myna `syncShow` (`internal/cli/webdav_cli.go:435`), over Neolix's parts. */
async function showCommand(kind: SyncKind, options: CommandOptions) {
  const target = options.daemonTarget;
  if (target && target.kind !== "instance") {
    return showRemote(kind, target);
  }
  const home = localHome(options);
  const config = await loadSyncConfig(home);
  const state = await loadState(home);
  const view = config ? syncConfigView(config) : null;
  const text = describeSync(kind, view, state);
  return textResult(text, {
    on: view?.enabled === true,
    ...(view?.enabled
      ? {
          url: view.url,
          backend: backendOf(view.url),
          user: view.user,
          passwordSet: view.passwordSet,
          keys: view.keys,
          parts: view.parts,
          intervalMinutes: view.intervalMinutes,
        }
      : {}),
    ...(state?.last ? { last: state.last } : {}),
    ...(state?.error ? { error: state.error } : {}),
  });
}

/**
 * A host other than this computer: its files are not here, so the daemon
 * answers what it is syncing and how the last sync went.
 */
async function showRemote(kind: SyncKind, target: NonNullable<CommandOptions["daemonTarget"]>) {
  const client = await connectToDaemon({ target });
  try {
    if (client.getLastServerInfoMessage()?.features?.sync !== true) {
      throw new Error("This host runs a Neox without sync: update the host and try again");
    }
    const [configResult, statusResult] = await Promise.all([
      client.getSyncConfig(),
      client.getSyncStatus(),
    ]);
    const view = configResult.config;
    const status = statusResult.status;
    const text = describeSync(kind, view, status);
    return textResult(text, {
      on: view.enabled,
      ...(view.enabled
        ? {
            url: view.url,
            backend: backendOf(view.url),
            user: view.user,
            passwordSet: view.passwordSet,
            keys: view.keys,
            parts: view.parts,
            intervalMinutes: view.intervalMinutes,
          }
        : {}),
      ...(status.last ? { last: status.last } : {}),
      ...(status.error ? { error: status.error } : {}),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function describeSync(
  kind: SyncKind,
  view: SyncConfigView | null,
  state: { last?: string; error?: string; notice?: SyncStatusView["notice"] } | null,
): string {
  const info = KINDS[kind];
  if (!view?.enabled) {
    return `${info.name} sync is off\n${turnOn(kind)}`;
  }
  const backend = KINDS[backendOf(view.url)];
  const who: string[] = [];
  if (backend.cmd === "s3") {
    who.push(view.endpoint || "AWS");
    if (view.region) {
      who.push(view.region);
    }
    if (view.pathStyle) {
      who.push("path-style");
    }
    if (view.user) {
      who.push(`access key ${view.user}`);
    }
    if (view.passwordSet) {
      who.push("secret saved");
    }
  } else if (backend.cmd === "github") {
    if (view.branch) {
      who.push(view.branch);
    }
    if (view.passwordSet) {
      who.push("token saved");
    }
  } else {
    if (view.user) {
      who.push(view.user);
    }
    if (view.passwordSet) {
      who.push("password saved");
    }
  }
  const lines = [`${backend.name} sync ${view.url}${who.length > 0 ? `  ${who.join(" · ")}` : ""}`];
  const synced: string[] = [
    view.keys ? "providers with their API keys" : "providers without their API keys",
  ];
  synced.push("settings", "profiles");
  if (view.parts.models) {
    synced.push("agents' models");
  }
  if (view.parts.library) {
    synced.push("library");
  }
  lines.push(`  syncs ${synced.join(", ")}`);
  lines.push(
    view.intervalMinutes === MANUAL_INTERVAL
      ? "  only when asked"
      : `  every ${view.intervalMinutes} minutes while the daemon runs`,
  );
  if (state?.error) {
    lines.push(`  couldn't sync: ${state.error}`);
  } else if (state?.last) {
    lines.push(`  last sync: ${new Date(state.last).toLocaleString()}`);
  } else {
    lines.push("  not synced yet");
  }
  if (state?.notice) {
    if (state.notice.here.length > 0) {
      lines.push(
        state.notice.restored
          ? `  restored from the server: ${state.notice.here.join(", ")}`
          : `  replaced here by newer ones from another computer: ${state.notice.here.join(", ")}`,
      );
    }
    if (state.notice.there.length > 0) {
      lines.push(
        `  replaced on the server by this computer's newer ones: ${state.notice.there.join(", ")}`,
      );
    }
    if (state.notice.saved) {
      lines.push(`  the copies replaced are kept in ${state.notice.saved}`);
    }
  }
  return lines.join("\n");
}

interface ParsedFields {
  address?: string;
  user?: string;
  branch?: string;
  bucket?: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  keys?: boolean;
  models?: boolean;
  library?: boolean;
  askSecret: boolean;
  askPassphrase: boolean;
}

function parseFields(kind: SyncKind, args: string[]): ParsedFields {
  const out: ParsedFields = { askSecret: false, askPassphrase: false };
  for (const arg of args) {
    const cut = arg.indexOf("=");
    const rawKey = cut < 0 ? arg : arg.slice(0, cut);
    // A bare address may carry "=" in its query; a field's "=" is the first
    // one, unless the key itself is an address (myna `syncSet`).
    const isAddress = cut < 0 || rawKey.includes("://");
    const key = isAddress ? "address" : rawKey;
    const value = isAddress ? arg : arg.slice(cut + 1);
    switch (key) {
      case "address":
        if (out.address !== undefined) {
          throw new Error(`one address, not ${JSON.stringify(arg)} too\n\n${KINDS[kind].usage}`);
        }
        out.address = value;
        break;
      case "user":
        if (kind !== "webdav") {
          throw unknownField(kind, key);
        }
        out.user = value;
        break;
      case "access-key-id":
        if (kind !== "s3") {
          throw unknownField(kind, key);
        }
        out.user = value;
        break;
      case "branch":
        if (kind !== "github") {
          throw unknownField(kind, key);
        }
        out.branch = value;
        break;
      case "bucket":
        if (kind !== "s3") {
          throw unknownField(kind, key);
        }
        out.bucket = value;
        break;
      case "prefix":
        if (kind !== "s3") {
          throw unknownField(kind, key);
        }
        out.prefix = value;
        break;
      case "endpoint":
        if (kind !== "s3") {
          throw unknownField(kind, key);
        }
        out.endpoint = value;
        break;
      case "region":
        if (kind !== "s3") {
          throw unknownField(kind, key);
        }
        out.region = value;
        break;
      case "path-style":
        if (kind !== "s3") {
          throw unknownField(kind, key);
        }
        out.pathStyle = yesOrNo(key, value);
        break;
      case "password":
      case "secret":
      case "token":
        if (key !== secretName(kind)) {
          throw unknownField(kind, key);
        }
        if (value !== "") {
          throw new Error(`the ${key} is asked for, not given: ${key}= alone`);
        }
        out.askSecret = true;
        break;
      case "passphrase":
        if (value !== "") {
          throw new Error("the passphrase is asked for, not given: passphrase= alone");
        }
        out.askPassphrase = true;
        break;
      case "keys":
        out.keys = yesOrNo(key, value);
        break;
      case "agents":
        out.models = yesOrNo(key, value);
        break;
      case "library":
        out.library = yesOrNo(key, value);
        break;
      default:
        throw unknownField(kind, key);
    }
  }
  return out;
}

function secretName(kind: SyncKind): string {
  if (kind === "s3") {
    return "secret";
  }
  return kind === "github" ? "token" : "password";
}

function yesOrNo(key: string, value: string): boolean {
  if (value !== "yes" && value !== "no") {
    throw new Error(`${key}=yes|no, not ${JSON.stringify(value)}`);
  }
  return value === "yes";
}

function unknownField(kind: SyncKind, key: string): Error {
  const fields: Record<SyncKind, string> = {
    s3: "address, bucket, prefix, endpoint, region, access-key-id, secret, passphrase, path-style, keys, agents, library",
    github: "address, branch, token, passphrase, keys, agents, library",
    webdav: "address, user, password, passphrase, keys, agents, library",
  };
  return new Error(`unknown field ${JSON.stringify(key)} (${fields[kind]})`);
}

async function setCommand(kind: SyncKind, args: string[], on: boolean, options: CommandOptions) {
  const home = localHome(options);
  const existing = await loadSyncConfig(home);
  const enabledKind = existing?.enabled ? backendOf(existing.url) : null;
  if (enabledKind && enabledKind !== kind) {
    if (!on) {
      throw new Error(
        `${KINDS[enabledKind].name} sync is on, not ${KINDS[kind].name}: neox ${enabledKind} set changes it; ${turnOn(kind)}`,
      );
    }
  }
  if (!existing?.enabled && !on) {
    throw new Error(`${KINDS[kind].name} sync is off: ${turnOn(kind)}`);
  }

  const base: SyncConfig =
    existing && (!existing.enabled || enabledKind === kind)
      ? { ...existing, parts: { ...existing.parts } }
      : {
          ...defaultSyncConfig(),
          // myna turns a new setup on with the providers' keys.
          keys: true,
          passphrase: existing?.passphrase ?? "",
        };
  const fields = parseFields(kind, args);
  if (fields.address !== undefined) {
    base.url = fields.address;
  }
  if (base.url.trim() === "") {
    throw new Error(`${KINDS[kind].name} sync needs an address: ${turnOn(kind)}`);
  }
  if (fields.user !== undefined) {
    base.user = fields.user;
  }
  if (fields.branch !== undefined) {
    base.branch = fields.branch;
  }
  if (fields.endpoint !== undefined) {
    base.endpoint = fields.endpoint;
  }
  if (fields.region !== undefined) {
    base.region = fields.region;
  }
  if (fields.pathStyle !== undefined) {
    base.pathStyle = fields.pathStyle;
  }
  if (fields.bucket !== undefined || fields.prefix !== undefined) {
    const [bucket, ...rest] = base.url.replace(/^s3:\/\//, "").split("/");
    const prefix = rest.join("/");
    base.url = `s3://${fields.bucket ?? bucket}${(fields.prefix ?? prefix) ? `/${fields.prefix ?? prefix}` : ""}`;
  }
  if (fields.keys !== undefined) {
    base.keys = fields.keys;
  }
  if (fields.models !== undefined) {
    base.parts.models = fields.models;
  }
  if (fields.library !== undefined) {
    base.parts.library = fields.library;
  }
  base.enabled = true;

  const secret = secretName(kind);
  const needSecret =
    fields.askSecret || (!base.password && (kind !== "webdav" || Boolean(base.user)));
  if (needSecret) {
    base.password = await askSecret(`${secret[0]!.toUpperCase()}${secret.slice(1)}: `);
  }
  if (!base.passphrase || fields.askPassphrase) {
    base.passphrase = await askPassphrase("Passphrase: ", true);
  }
  await saveSyncConfig(home, base);

  const lines = [`${KINDS[kind].name} sync saved: ${base.url}`];
  if (on) {
    const status = await tryRun(options);
    lines.push(
      status ??
        `Saved. The daemon isn't reachable, so nothing was synced yet: run neox ${kind} now.`,
    );
  }
  const state = await loadState(home);
  lines.push("", describeSync(kind, syncConfigView(base), state));
  return textResult(lines.join("\n"), {
    on: true,
    url: base.url,
    backend: kind,
    keys: base.keys,
    parts: base.parts,
    intervalMinutes: base.intervalMinutes,
  });
}

async function autoCommand(kind: SyncKind, args: string[], options: CommandOptions) {
  if (args.length !== 1) {
    throw new Error(`neox ${kind} auto off|3|15|30|60`);
  }
  const value = args[0]!;
  const minutes = value === "off" ? MANUAL_INTERVAL : Number(value);
  if (!Number.isInteger(minutes) || (minutes !== MANUAL_INTERVAL && minutes <= 0)) {
    throw new Error(`neox ${kind} auto off|3|15|30|60, not ${JSON.stringify(value)}`);
  }
  const home = localHome(options);
  const config = await loadSyncConfig(home);
  if (!config?.enabled) {
    throw new Error(`${KINDS[kind].name} sync is off: ${turnOn(kind)}`);
  }
  config.intervalMinutes = minutes;
  await saveSyncConfig(home, config);
  return showCommand(kind, options);
}

async function offCommand(kind: SyncKind, options: CommandOptions) {
  const home = localHome(options);
  const existing = await loadSyncConfig(home);
  if (existing?.enabled) {
    const running = backendOf(existing.url);
    if (running !== kind) {
      throw new Error(
        `${KINDS[running].name} sync is on, not ${KINDS[kind].name}: neox ${running} off turns it off`,
      );
    }
  }
  if (existing) {
    existing.enabled = false;
    await saveSyncConfig(home, existing);
  }
  const message: string = {
    s3: "S3 sync is off; the files in the bucket stay",
    github: "GitHub sync is off; the encrypted files and their commit history stay",
    webdav: "WebDAV sync is off; the files on the server stay",
  }[kind];
  return textResult(message, { on: false });
}

async function runtimeCommand(
  kind: SyncKind,
  action: "now" | "restore" | "undo" | "upload" | "dismiss",
  options: CommandOptions,
) {
  const config = await loadSyncConfig(localHome(options));
  if (!config?.enabled) {
    throw new Error(`${KINDS[kind].name} sync is off: ${turnOn(kind)}`);
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.sync !== true) {
      throw new Error("This host's Neox doesn't support sync yet: update the host.");
    }
    if (action === "now") {
      const payload = await client.runSync();
      const status = payload.status as SyncStatusView;
      const error = payload.error ?? status.error;
      if (error) {
        throw new Error(`couldn't sync: ${error}`);
      }
      return textResult("synced", { on: true, last: new Date().toISOString() });
    }
    if (action === "restore") {
      const payload = await client.restoreSync();
      const parts = payload.status?.notice?.here ?? [];
      const text =
        parts.length === 0
          ? "nothing differed: nothing was replaced"
          : `restored from the server: ${parts.join(", ")}; what was here is kept, and neox ${kind} undo puts it back`;
      return textResult(text, { parts });
    }
    if (action === "undo") {
      const payload = await client.undoSync();
      const parts = payload.status?.notice?.here ?? [];
      return textResult(
        parts.length === 0 ? "nothing to put back" : `put back: ${parts.join(", ")}`,
        {
          parts,
        },
      );
    }
    if (action === "upload") {
      await client.uploadSync();
      return textResult(
        "this computer's setup is on the server now; the server's files were replaced",
        { on: true },
      );
    }
    await client.dismissSyncNotice();
    return showCommand(kind, options);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** `on` syncs at once; a daemon that isn't running leaves the setup saved. */
async function tryRun(options: CommandOptions): Promise<string | null> {
  try {
    const client = await connectToDaemon({ target: options.daemonTarget });
    try {
      if (client.getLastServerInfoMessage()?.features?.sync !== true) {
        return "Saved. This host's Neox doesn't support sync yet: update the host.";
      }
      const payload = await client.runSync();
      const error = payload.error ?? payload.status.error;
      return error ? `saved, but the sync failed: ${error}` : "saved, and synced";
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}
