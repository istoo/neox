import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsCommand } from "./index.js";
import {
  settingDefault,
  settingValue,
  settingsFields,
  shown,
  type SettingField,
} from "./fields.js";
import { appSettingFields, appSettingValue } from "./fields-app.js";
import { patchAppSetting, readAppSettings } from "./bridge.js";

vi.mock("./bridge.js", () => ({
  readAppSettings: vi.fn(),
  patchAppSetting: vi.fn(),
}));

let home: string;
let printed: string[];

async function run(...args: string[]): Promise<string[]> {
  printed = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  try {
    await createSettingsCommand().parseAsync(args, { from: "user" });
  } finally {
    write.mockRestore();
  }
  return printed
    .join("")
    .split("\n")
    .filter((line) => line !== "");
}

function config(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-settings-"));
  process.env.NEOLIX_HOME = home;
  vi.mocked(readAppSettings).mockReset().mockResolvedValue({ theme: "dark", language: "en" });
  vi.mocked(patchAppSetting).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.NEOLIX_HOME;
});

describe("neox settings", () => {
  it("lists every setting with its value and default", async () => {
    const lines = await run("list");
    const port = lines.find((line) => line.startsWith("daemon.port"));
    expect(port).toContain("6868");
    expect(port).toContain("number, default 6868");
    expect(lines.some((line) => line.startsWith("app.baseUrl"))).toBe(true);
    expect(lines.some((line) => line.startsWith("log.level"))).toBe(true);
    expect(lines.some((line) => line.startsWith("daemon.auth"))).toBe(false);
  });

  it("prints rows as JSON with --json", async () => {
    const lines = await run("list", "--json");
    const rows = JSON.parse(lines.join("\n")) as Array<Record<string, unknown>>;
    const port = rows.find((row) => row.key === "daemon.port");
    expect(port).toMatchObject({ type: "number", value: null, default: 6868 });
  });

  it("sets a switch, a number and a list, checked and saved", async () => {
    expect(await run("set", "daemon.lan", "on")).toEqual(["✓ daemon.lan on"]);
    expect(await run("set", "daemon.port", "7000")).toEqual(["✓ daemon.port 7000"]);
    expect(await run("set", "daemon.cors.allowedOrigins", "http://a.test, http://b.test")).toEqual([
      "✓ daemon.cors.allowedOrigins http://a.test,http://b.test",
    ]);
    const saved = config();
    expect(saved.daemon).toMatchObject({
      lan: true,
      port: 7000,
      cors: { allowedOrigins: ["http://a.test", "http://b.test"] },
    });
  });

  it("gets one value, as text and as JSON", async () => {
    await run("set", "daemon.port", "7000");
    expect(await run("get", "daemon.port")).toEqual(["7000"]);
    expect(await run("get", "daemon.port", "--json")).toEqual(["7000"]);
  });

  it("resets a setting to its default", async () => {
    await run("set", "daemon.port", "7000");
    expect(await run("reset", "daemon.port")).toEqual(["✓ daemon.port 6868"]);
    expect((config().daemon as Record<string, unknown>).port).toBeUndefined();
  });

  it("rejects a value of the wrong shape before writing", () => {
    const port = settingsFields().find((field) => field.key === "daemon.port") as SettingField;
    expect(() => settingValue(port, "many")).toThrow('daemon.port is a number, not "many"');
    expect(() => settingValue(port, "1.5")).toThrow("daemon.port is a whole number");
    const lan = settingsFields().find((field) => field.key === "daemon.lan") as SettingField;
    expect(() => settingValue(lan, "maybe")).toThrow('daemon.lan is on or off, not "maybe"');
    const level = settingsFields().find((field) => field.key === "log.level") as SettingField;
    expect(() => settingValue(level, "loud")).toThrow(
      "log.level is trace|debug|info|warn|error|fatal",
    );
  });

  it("lists the app's settings from the copy the daemon keeps", async () => {
    const lines = await run("list");
    const theme = lines.find((line) => line.startsWith("theme "));
    expect(theme).toContain("dark");
    expect(theme).toContain("default auto");
    expect(lines.some((line) => line.startsWith("language "))).toBe(true);
    expect(readAppSettings).toHaveBeenCalledOnce();
  });

  it("gets an app setting from the copy the daemon keeps", async () => {
    expect(await run("get", "theme")).toEqual(["dark"]);
    expect(await run("get", "theme", "--json")).toEqual(['"dark"']);
    vi.mocked(readAppSettings).mockResolvedValue(null);
    expect(await run("get", "theme")).toEqual(["-"]);
  });

  it("writes an app setting through the daemon for the app to apply", async () => {
    expect(await run("set", "theme", "midnight")).toEqual(["✓ theme midnight"]);
    expect(vi.mocked(patchAppSetting).mock.calls[0]?.slice(1)).toEqual(["theme", "midnight"]);
    expect(vi.mocked(patchAppSetting)).toHaveBeenCalledOnce();
  });

  it("resets an app setting by unsetting it", async () => {
    expect(await run("reset", "theme")).toEqual(["✓ theme auto"]);
    expect(vi.mocked(patchAppSetting).mock.calls[0]?.slice(1)).toEqual(["theme", null]);
  });

  it("still lists config.json when the daemon is unreachable, and says so", async () => {
    vi.mocked(readAppSettings).mockRejectedValue(
      new Error(
        "app settings are kept by the app and read through the daemon, which is not reachable: boom. Nothing was changed.",
      ),
    );
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const lines = await run("list");
      expect(lines.some((line) => line.startsWith("daemon.port"))).toBe(true);
      expect(lines.some((line) => line.startsWith("theme "))).toBe(false);
      const said = warning.mock.calls.map((call) => String(call[0])).join("");
      expect(said).toContain("not reachable");
      expect(said).toContain("missing from this list");
    } finally {
      warning.mockRestore();
    }
  });

  it("checks app values the same way before sending them", () => {
    const theme = appSettingFields().find((field) => field.key === "theme");
    if (theme === undefined) {
      throw new Error("theme is not an app field");
    }
    expect(() => appSettingValue(theme, "sepia")).toThrow("theme is auto|light|dark");
    expect(appSettingValue(theme, "midnight")).toBe("midnight");
  });

  it("keeps sessionTerminal in config.json, where the host reads it", () => {
    const field = settingsFields().find((entry) => entry.key === "sessionTerminal");
    expect(field?.type).toBe("text");
    expect(settingDefault("sessionTerminal")).toBe("");
    expect(appSettingFields().some((entry) => entry.key === "sessionTerminal")).toBe(false);
  });

  it("keeps app keys apart from config.json keys", () => {
    const configKeys = new Set(settingsFields().map((field) => field.key));
    const keys = appSettingFields().map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(configKeys.has(key)).toBe(false);
    }
  });

  it("names values as myna does", () => {
    expect(shown(true)).toBe("on");
    expect(shown("")).toBe('""');
    expect(shown([])).toBe("[]");
    expect(shown(["a", "b"])).toBe("a,b");
    expect(shown(undefined)).toBe("-");
    expect(shown({ a: 1 })).toBe('{"a":1}');
  });
});
