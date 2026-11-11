// User shortcut changes, kept in a file next to the bridge's settings. Everything the editor
// changes is stored as config rules grouped by command: a command listed here uses exactly these
// rules instead of its shipped defaults, and an `unassigned` rule keeps a command that lost its
// last shortcut from silently getting the default back.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  KeybindingRule,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  type ServerConfigIssue,
  type ServerEditKeybindingsInput,
  type ServerUpsertKeybindingInput,
  type ServerUpsertKeybindingResult,
} from "@synara/contracts";
import {
  compileKeybindingRule,
  isUnassignedKeybindingRule,
  keybindingRuleIdentity,
} from "@synara/shared/keybindingRules";
import { Schema } from "effect";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

const decodeRule = Schema.decodeUnknownOption(KeybindingRule);
const MAX_RULES = 256;

type Listener = (keybindings: ResolvedKeybindingsConfig) => void;

export interface KeybindingsStateSources {
  readonly file: string;
  readonly log: (line: string) => void;
}

export class KeybindingsState {
  private readonly overrides = new Map<string, KeybindingRule[]>();
  private readonly listeners = new Set<Listener>();
  private loadIssues: ServerConfigIssue[] = [];
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly sources: KeybindingsStateSources) {}

  get path(): string {
    return this.sources.file;
  }

  /** Problems with the saved file, reported on every config read. */
  issues(): readonly ServerConfigIssue[] {
    return this.loadIssues;
  }

  async resolved(): Promise<ResolvedKeybindingsConfig> {
    await this.load();
    return this.resolve();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    void this.resolved().then(listener, (error) =>
      this.sources.log(`keybindings unreadable: ${String(error)}`),
    );
    return () => this.listeners.delete(listener);
  }

  upsert(input: ServerUpsertKeybindingInput): Promise<ServerUpsertKeybindingResult> {
    return this.edit({ edits: [{ type: "set", rule: input.rule }] });
  }

  edit(input: ServerEditKeybindingsInput): Promise<ServerUpsertKeybindingResult> {
    // Edits are serialized: the editor sends a remove followed by a set, and a second window
    // can send another batch before the first write lands.
    const run = this.queue.then(async () => {
      await this.load();
      const editIssues: ServerConfigIssue[] = [];
      for (const [index, edit] of input.edits.entries()) {
        if (edit.type === "set") {
          const identity = keybindingRuleIdentity(edit.rule);
          if (!identity) {
            editIssues.push(invalidEntry(index));
            continue;
          }
          this.setRule(edit.rule, edit.replacing);
        } else if (edit.type === "remove") {
          const identity = keybindingRuleIdentity(edit.rule);
          if (!identity) {
            editIssues.push(invalidEntry(index));
            continue;
          }
          this.removeRule(edit.rule);
        } else {
          if (edit.command) this.overrides.delete(edit.command);
          else this.overrides.clear();
        }
      }
      this.trimToLimit(editIssues);
      await this.save();
      const result: ServerUpsertKeybindingResult = {
        keybindings: this.resolve(),
        issues: [...this.loadIssues, ...editIssues],
      };
      const resolved = result.keybindings;
      for (const listener of this.listeners) listener(resolved);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setRule(rule: KeybindingRule, replacing: KeybindingRule | undefined): void {
    let rules = this.currentRules(rule.command);
    const identity = keybindingRuleIdentity(rule);
    const replacedIdentity = replacing ? keybindingRuleIdentity(replacing) : null;
    if (replacedIdentity)
      rules = rules.filter((candidate) => keybindingRuleIdentity(candidate) !== replacedIdentity);
    if (identity && !rules.some((candidate) => keybindingRuleIdentity(candidate) === identity)) {
      // A command that was left unassigned gains a real shortcut; drop the tombstone.
      rules = rules.filter((candidate) => !isUnassignedKeybindingRule(candidate));
      rules.push(rule);
    }
    this.overrides.set(rule.command, rules.length > 0 ? rules : [rule]);
  }

  private removeRule(rule: KeybindingRule): void {
    const identity = keybindingRuleIdentity(rule);
    if (!identity) return;
    const rules = this.currentRules(rule.command).filter(
      (candidate) => keybindingRuleIdentity(candidate) !== identity,
    );
    this.overrides.set(
      rule.command,
      rules.length > 0 ? rules : [{ key: "unassigned", command: rule.command }],
    );
  }

  private currentRules(command: string): KeybindingRule[] {
    const overridden = this.overrides.get(command);
    if (overridden) return [...overridden];
    return DEFAULT_KEYBINDINGS.filter((rule) => rule.command === command);
  }

  private resolve(): ResolvedKeybindingsConfig {
    const resolved: ResolvedKeybindingRule[] = [];
    const emitted = new Set<string>();
    const push = (rules: readonly KeybindingRule[], command: string) => {
      emitted.add(command);
      for (const rule of rules) {
        const compiled = compileKeybindingRule(rule);
        if (compiled) resolved.push(compiled);
      }
    };
    for (const rule of DEFAULT_KEYBINDINGS) {
      if (emitted.has(rule.command)) continue;
      const overridden = this.overrides.get(rule.command);
      if (overridden) {
        push(overridden, rule.command);
        continue;
      }
      const compiled = compileKeybindingRule(rule);
      if (compiled) resolved.push(compiled);
    }
    for (const [command, rules] of this.overrides) {
      if (!emitted.has(command)) push(rules, command);
    }
    return resolved;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = await fs.readFile(this.sources.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.loadIssues = [
          {
            kind: "keybindings.malformed-config",
            message: `Keybindings file could not be read: ${String(error)}`,
          },
        ];
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.loadIssues = [
        { kind: "keybindings.malformed-config", message: "Keybindings file is not valid JSON." },
      ];
      return;
    }
    if (!Array.isArray(raw)) {
      this.loadIssues = [
        {
          kind: "keybindings.malformed-config",
          message: "Keybindings file must be an array of rules.",
        },
      ];
      return;
    }
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of raw.entries()) {
      const decoded = decodeRule(entry);
      if (decoded._tag !== "Some") {
        issues.push(invalidEntry(index));
        continue;
      }
      const rule = decoded.value;
      const rules = this.overrides.get(rule.command) ?? [];
      rules.push(rule);
      this.overrides.set(rule.command, rules);
    }
    this.loadIssues = issues;
    this.trimToLimit(issues);
  }

  private trimToLimit(issues: ServerConfigIssue[]): void {
    let total = [...this.overrides.values()].reduce((sum, rules) => sum + rules.length, 0);
    if (total <= MAX_RULES) return;
    // debt: the editor never approaches the 256-rule budget; if it ever does, reject the edit
    // instead of silently dropping the oldest overrides.
    issues.push({
      kind: "keybindings.invalid-entry",
      message: `Keybindings exceed the ${MAX_RULES}-rule limit; the oldest changes were dropped.`,
      index: MAX_RULES,
    });
    for (const [command, rules] of [...this.overrides]) {
      if (total <= MAX_RULES) break;
      total -= rules.length;
      this.overrides.delete(command);
    }
  }

  /** Temp file then rename, so a crash never leaves a half-written config. */
  private async save(): Promise<void> {
    const rules = [...this.overrides.values()].flat();
    await fs.mkdir(path.dirname(this.sources.file), { recursive: true });
    const temp = `${this.sources.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
    await fs.rename(temp, this.sources.file);
  }
}

function invalidEntry(index: number): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    message: `Entry ${index} is not a valid shortcut rule.`,
    index,
  };
}
