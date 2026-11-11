import { Command } from "commander";
import {
  editPersistedConfig,
  getPersistedConfigValue,
  readPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "@neolix/server/configuration";
import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import {
  settingDefault,
  settingValue,
  settingsFields,
  shown,
  type SettingField,
} from "./fields.js";
import { appSettingField, appSettingFields, type AppSettingField } from "./fields-app.js";
import { patchAppSetting, readAppSettings } from "./bridge.js";

/**
 * `neolix settings` — myna's `myna settings list|get|set|reset`
 * (internal/cli/settings_cli.go:16): every setting this computer's config.json
 * holds, with its value now and its default, checked against the schema the
 * daemon reads. A change is written to the file; fields the daemon binds at
 * start (the port, sharing) take effect at the next start, as myna says.
 *
 * The app's own settings (theme, language, sidebar layout) aren't in
 * config.json: the app keeps them and pushes a copy to the daemon, so those
 * keys are read from that copy and written back through the daemon for the
 * app to apply.
 */

const USAGE = `  neox settings [list] [--json]          every setting config.json holds: its value now and its default
  neox settings get <key> [--json]       one setting's value
  neox settings set <key> <value>        set one, checked and saved as the daemon reads it
  neox settings reset <key>              one back to its default

  a value is on|off (or true|false) for a switch, a number, words, a list as a,b,c
  (or a JSON array), and JSON for an object.
  the app's own settings are read from the copy the app keeps in the daemon,
  and a set is applied by the app, so the daemon must be reachable.`;

interface SettingRow {
  key: string;
  type: string;
  value: unknown;
  default: unknown;
  choices?: string[];
}

function homeOf(options: CommandOptions): string {
  if (options.daemonTarget.kind !== "instance") {
    throw new Error("Settings edits require --home");
  }
  return options.daemonTarget.home;
}

/** A key the CLI knows: one in config.json, or one only the app keeps. */
function knownField(key: string): SettingField | AppSettingField {
  const app = appSettingField(key);
  if (app !== null) {
    return app;
  }
  const fields = settingsFields();
  const found = fields.find((field) => field.key === key);
  if (found !== undefined) {
    return found;
  }
  const keys = [
    ...fields.map((field) => field.key),
    ...appSettingFields().map((field) => field.key),
  ];
  const lower = key.toLowerCase();
  const near = keys.filter(
    (name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()),
  );
  const hint = near.length > 0 ? `: did you mean ${near.join(", ")}?` : "";
  throw new Error(
    `no setting "${key}"${hint} (neox settings list names them all): nothing was changed`,
  );
}

function rows(home: string): SettingRow[] {
  const config = readPersistedConfig(home, { defaultsIfMissing: true });
  return settingsFields().map((field) => {
    const value = getPersistedConfigValue(config, field.key);
    const row: SettingRow = {
      key: field.key,
      type: field.type,
      value: value ?? null,
      default: settingDefault(field.key) ?? null,
    };
    if (field.choices !== undefined) {
      row.choices = field.choices;
    }
    return row;
  });
}

/** The app's settings, as the daemon's copy of them holds each value. */
function appRows(settings: Record<string, unknown> | null): SettingRow[] {
  return appSettingFields().map((field) => {
    const row: SettingRow = {
      key: field.key,
      type: field.type,
      value: settings?.[field.key] ?? null,
      default: field.default ?? null,
    };
    if (field.choices !== undefined) {
      row.choices = field.choices;
    }
    return row;
  });
}

function listText(list: readonly SettingRow[]): string {
  const width = list.reduce((most, row) => Math.max(most, row.key.length), 0);
  return list
    .map((row) => {
      const value = shown(row.value);
      const fallback = shown(row.default);
      let note =
        row.choices !== undefined && row.choices.length > 0 ? row.choices.join("|") : row.type;
      if (value !== fallback) {
        note += `, default ${fallback}`;
      }
      return `${row.key.padEnd(width)}  ${value} (${note})`;
    })
    .join("\n");
}

function listResult(list: SettingRow[]) {
  return {
    type: "list" as const,
    data: list,
    schema: {
      idField: (row: SettingRow) => row.key,
      columns: [],
      renderHuman: () => listText(list),
    },
  };
}

function single<T>(data: T, human: (value: T) => string) {
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "settings",
      columns: [],
      renderHuman: () => human(data),
    },
  };
}

function savedText(key: string, value: unknown): string {
  return `✓ ${key} ${shown(value)}`;
}

/** Edits config.json, letting the daemon's parser judge the whole file. */
function edited(
  home: string,
  key: string,
  edit: { value: unknown } | { unset: true },
): PersistedConfig {
  const before = readPersistedConfig(home, { defaultsIfMissing: true });
  editPersistedConfig(home, key, edit);
  try {
    return readPersistedConfig(home, { defaultsIfMissing: true });
  } catch (cause) {
    savePersistedConfig(home, before);
    const first = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new Error(`${key}: ${first}: nothing was changed`, { cause });
  }
}

async function listAction(options: CommandOptions) {
  const list = rows(homeOf(options));
  try {
    list.push(...appRows(await readAppSettings(options)));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`warning: ${reason}\n`);
    process.stderr.write(
      `warning: the app's ${appSettingFields().length} settings are missing from this list\n`,
    );
  }
  return listResult(list);
}

async function getAction(key: string, options: CommandOptions) {
  knownField(key);
  if (appSettingField(key) !== null) {
    const settings = await readAppSettings(options);
    return single(settings?.[key] ?? null, shown);
  }
  const config = readPersistedConfig(homeOf(options), { defaultsIfMissing: true });
  const value = getPersistedConfigValue(config, key) ?? null;
  return single(value, shown);
}

async function setAction(key: string, text: string, options: CommandOptions) {
  const field = knownField(key);
  const value = settingValue(field, text);
  if (appSettingField(key) !== null) {
    await patchAppSetting(options, key, value);
    return single({ key, value }, (saved) => savedText(saved.key, saved.value));
  }
  const config = edited(homeOf(options), key, { value });
  return single({ key, value: getPersistedConfigValue(config, key) ?? null }, (saved) =>
    savedText(saved.key, saved.value),
  );
}

async function resetAction(key: string, options: CommandOptions) {
  const field = knownField(key);
  const app = appSettingField(key);
  if (app !== null) {
    // An unset, not the default this registry happens to name: the app drops
    // its local value and falls back to the default of the platform it runs
    // on (the font sizes differ between web and native).
    await patchAppSetting(options, key, null);
    const value = app.default ?? null;
    return single({ key, value }, (saved) => savedText(saved.key, saved.value));
  }
  edited(homeOf(options), key, { unset: true });
  return single({ key, value: settingDefault(field.key) ?? null }, (saved) =>
    savedText(saved.key, saved.value),
  );
}

export function createSettingsCommand(): Command {
  const settings = new Command("settings").description(
    "Read or edit this computer's settings (local operation; the daemon reads config.json at start)",
  );
  addLocalDaemonOptions(settings);
  settings
    .addHelpText("after", `\n${USAGE}`)
    .option("-j, --json", "output in JSON format")
    .action(
      withOutput(async (options: CommandOptions, _command: Command) => {
        return listAction(options);
      }),
    );

  addLocalDaemonOptions(
    settings
      .command("list")
      .alias("ls")
      .description("Every setting, its value now and its default"),
  )
    .option("-j, --json", "output in JSON format")
    .action(
      withOutput(async (options: CommandOptions, _command: Command) => {
        return listAction(options);
      }),
    );

  addLocalDaemonOptions(settings.command("get <key>").description("One setting's value"))
    .option("-j, --json", "output in JSON format")
    .action(
      withOutput(async (key: string, options: CommandOptions, _command: Command) => {
        return getAction(key, options);
      }),
    );

  addLocalDaemonOptions(
    settings.command("set <key> <value>").description("Set one setting"),
  ).action(
    withOutput(async (key: string, value: string, options: CommandOptions, _command: Command) => {
      return setAction(key, value, options);
    }),
  );

  addLocalDaemonOptions(
    settings.command("reset <key>").description("One setting back to default"),
  ).action(
    withOutput(async (key: string, options: CommandOptions, _command: Command) => {
      return resetAction(key, options);
    }),
  );

  return settings;
}
