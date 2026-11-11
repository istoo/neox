import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServerUpsertKeybindingResult } from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { KeybindingsState } from "./keybindingsState.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeState(contents?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-keybindings-"));
  dirs.push(dir);
  const file = path.join(dir, "desktop-web", "keybindings.json");
  if (contents !== undefined) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
  return { file, state: new KeybindingsState({ file, log: () => {} }) };
}

const encode = (value: unknown) =>
  Schema.encodeUnknownSync(ServerUpsertKeybindingResult as never)(value);

describe("keybindingsState", () => {
  it("replaces a shipped binding and persists it across restarts", async () => {
    const { file, state } = await makeState();
    const result = await state.edit({
      edits: [
        {
          type: "set",
          rule: { key: "mod+shift+b", command: "sidebar.toggle", when: "!terminalFocus" },
          replacing: { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
        },
      ],
    });
    expect(() => encode(result)).not.toThrow();
    const binding = result.keybindings.find((rule) => rule.command === "sidebar.toggle");
    expect(binding?.shortcut).toMatchObject({ key: "b", shiftKey: true, modKey: true });
    expect(result.keybindings.filter((rule) => rule.command === "sidebar.toggle")).toHaveLength(1);

    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual([
      { key: "mod+shift+b", command: "sidebar.toggle", when: "!terminalFocus" },
    ]);

    const restarted = new KeybindingsState({ file, log: () => {} });
    const rules = await restarted.resolved();
    expect(rules.filter((rule) => rule.command === "sidebar.toggle")).toHaveLength(1);
  });

  it("leaves a command unassigned when its last binding is removed", async () => {
    const { state } = await makeState();
    const result = await state.edit({
      edits: [
        {
          type: "remove",
          rule: { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
        },
      ],
    });
    const rules = result.keybindings.filter((rule) => rule.command === "sidebar.toggle");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.shortcut.key).toBe("unassigned");
    expect(() => encode(result)).not.toThrow();
  });

  it("restores the shipped bindings on reset", async () => {
    const { state } = await makeState();
    await state.edit({
      edits: [{ type: "set", rule: { key: "mod+shift+b", command: "sidebar.toggle" } }],
    });
    const result = await state.edit({ edits: [{ type: "reset", command: "sidebar.toggle" }] });
    expect(result.keybindings.filter((rule) => rule.command === "sidebar.toggle")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "sidebar.toggle",
          shortcut: expect.objectContaining({ key: "b" }),
        }),
      ]),
    );
    expect(result.keybindings.some((rule) => rule.shortcut.key === "unassigned")).toBe(false);
  });

  it("reports a malformed file and still serves the shipped defaults", async () => {
    const { state } = await makeState("{not json");
    const rules = await state.resolved();
    expect(rules.some((rule) => rule.command === "sidebar.toggle")).toBe(true);
    expect(state.issues()).toEqual([
      { kind: "keybindings.malformed-config", message: "Keybindings file is not valid JSON." },
    ]);
  });

  it("reports invalid saved entries by index", async () => {
    const { state } = await makeState(JSON.stringify([{ key: "mod+b", command: "not.a.command" }]));
    await state.resolved();
    expect(state.issues()).toEqual([
      {
        kind: "keybindings.invalid-entry",
        message: "Entry 0 is not a valid shortcut rule.",
        index: 0,
      },
    ]);
  });
});
