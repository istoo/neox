import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeManagedFile } from "./store.js";
import type { LibraryBackup, LibraryPaths, StoredLibrary } from "./store.js";
import type { LibraryAgentTarget } from "./paths.js";
import { fail, markChanged, type AgentSyncContext } from "./result.js";

/**
 * The part of an agent's instructions file the library writes sits between
 * these two lines; everything else in the file is the user's and stays.
 *
 * Neolix uses its own marker, not myna's: an installed myna's block stays
 * myna's, and neither tool takes the other's text away.
 */
export const BLOCK_BEGIN = "<!-- neolix:begin · written by Neolix from its Library -->";
export const BLOCK_END = "<!-- neolix:end -->";

export const DEFAULT_SET_ID = "default";

export function instructionSetPath(paths: LibraryPaths, id: string): string {
  if (id === "" || id === DEFAULT_SET_ID) {
    return path.join(paths.dir, "instructions.md");
  }
  return path.join(paths.instructionSetsDir, `${id}.md`);
}

export function agentExtraPath(paths: LibraryPaths, agent: string): string {
  return path.join(paths.instructionsDir, `${agent}.md`);
}

export async function readText(file: string): Promise<string> {
  try {
    const raw = await readFile(file, "utf8");
    return raw.replace(/\r\n/g, "\n").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeText(file: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeManagedFile(file, `${trimmed}\n`);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function instructionSets(library: StoredLibrary): { id: string; name: string }[] {
  const sets = [{ id: DEFAULT_SET_ID, name: "" }];
  for (const set of library.instructions.sets) {
    if (set.id === DEFAULT_SET_ID) {
      sets[0] = { id: set.id, name: set.name };
    } else {
      sets.push({ id: set.id, name: set.name });
    }
  }
  return sets;
}

export function activeInstructionSet(library: StoredLibrary): string {
  const active = library.instructions.active;
  return instructionSets(library).some((set) => set.id === active) ? active : DEFAULT_SET_ID;
}

export function sharedInstructions(library: StoredLibrary, paths: LibraryPaths): Promise<string> {
  return readText(instructionSetPath(paths, activeInstructionSet(library)));
}

/** What the library writes into an agent's file: the shared text alone. */
export async function wantedInstructions(
  library: StoredLibrary,
  paths: LibraryPaths,
  agent: string,
): Promise<string> {
  if (!library.instructions.agents.includes(agent)) {
    return "";
  }
  const parts = [
    await readText(instructionSetPath(paths, activeInstructionSet(library))),
    await readText(agentExtraPath(paths, agent)),
  ].filter((part) => part.length > 0);
  return parts.join("\n\n");
}

interface SplitFile {
  before: string;
  block: string;
  after: string;
  hasBlock: boolean;
}

export function splitInstructionFile(file: string): SplitFile {
  const begin = file.indexOf(BLOCK_BEGIN);
  if (begin < 0) {
    return { before: file, block: "", after: "", hasBlock: false };
  }
  const rest = file.slice(begin + BLOCK_BEGIN.length);
  const end = rest.indexOf(BLOCK_END);
  if (end < 0) {
    return { before: file, block: "", after: "", hasBlock: false };
  }
  return {
    before: file.slice(0, begin),
    block: rest.slice(0, end).trim(),
    after: rest.slice(end + BLOCK_END.length),
    hasBlock: true,
  };
}

/** The file without the library's part: the user's own instructions. */
export function ownInstructions(file: string): string {
  let current = file;
  for (;;) {
    const split = splitInstructionFile(current);
    if (!split.hasBlock) {
      break;
    }
    current = `${split.before.trim()}\n\n${split.after.trim()}`;
  }
  return current.trim();
}

export function withInstructionBlock(file: string, text: string): string {
  const normalized = file.replace(/\r\n/g, "\n");
  const split = splitInstructionFile(normalized);
  const before = split.hasBlock ? split.before.replace(/\n+$/, "") : normalized.replace(/\n+$/, "");
  const after = split.hasBlock ? split.after.replace(/^\n+/, "") : "";
  const block = text.trim().length > 0 ? `${BLOCK_BEGIN}\n${text.trim()}\n${BLOCK_END}` : "";
  const parts = [before, block, after.replace(/\n+$/, "")].filter((part) => part.trim().length > 0);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

export interface AgentInstructionsView {
  agent: string;
  name: string;
  icon: string;
  path: string;
  on: boolean;
  extra: string;
  /** Lines of the user's own text in the file. */
  own: number;
  /** The library's block was edited in the file since the library wrote it. */
  edited: boolean;
  override?: string;
}

export interface InstructionsView {
  shared: string;
  sets: { id: string; name: string; text: string; active: boolean }[];
  agents: AgentInstructionsView[];
}

export async function readInstructionsView(
  library: StoredLibrary,
  paths: LibraryPaths,
  targets: readonly LibraryAgentTarget[],
): Promise<InstructionsView> {
  const view: InstructionsView = {
    shared: await readText(instructionSetPath(paths, activeInstructionSet(library))),
    sets: [],
    agents: [],
  };
  for (const set of instructionSets(library)) {
    view.sets.push({
      id: set.id,
      name: set.name,
      text: await readText(instructionSetPath(paths, set.id)),
      active: set.id === activeInstructionSet(library),
    });
  }
  for (const target of targets) {
    if (!target.instructionsPath) {
      continue;
    }
    const file = await readText(target.instructionsPath);
    const split = splitInstructionFile(file);
    const applied = library.applied[target.id];
    const own = ownInstructions(file);
    let override: string | undefined;
    if (target.overridePath && (await readText(target.overridePath)).length > 0) {
      override = target.overridePath;
    }
    view.agents.push({
      agent: target.id,
      name: target.name,
      icon: target.icon,
      path: target.instructionsPath,
      on: library.instructions.agents.includes(target.id),
      extra: await readText(agentExtraPath(paths, target.id)),
      own: own.length > 0 ? own.split("\n").length : 0,
      edited: Boolean(
        split.hasBlock && applied?.instrHash && hashText(split.block) !== applied.instrHash,
      ),
      ...(override ? { override } : {}),
    });
  }
  return view;
}

export interface InstructionsChange {
  shared?: string;
  agents?: string[];
  extra?: Record<string, string>;
  texts?: Record<string, string>;
  activate?: string;
  create?: { id: string; name: string };
  rename?: { id: string; name: string };
  remove?: string;
  /** Agents whose own text moves into the shared text. */
  importOwn?: string[];
  /** Agents told to take the library's text again, over their edits. */
  rewrite?: string[];
}

const setIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function applyCreateOrRename(library: StoredLibrary, change: InstructionsChange): void {
  if (change.create) {
    const { id, name } = change.create;
    if (!setIdPattern.test(id)) {
      throw new Error(`Set id ${JSON.stringify(id)}: use letters, digits, - and _ only`);
    }
    if (instructionSets(library).some((set) => set.id === id)) {
      throw new Error(`There is a set ${JSON.stringify(id)} already`);
    }
    if (name.trim().length === 0) {
      throw new Error("A new set needs a name");
    }
    library.instructions.sets.push({ id, name: name.trim() });
  }
  if (!change.rename) {
    return;
  }
  const { id, name } = change.rename;
  const existing = library.instructions.sets.find((set) => set.id === id);
  if (id === DEFAULT_SET_ID) {
    library.instructions.sets = library.instructions.sets.filter((set) => set.id !== id);
    library.instructions.sets.unshift({ id, name: name.trim() });
  } else if (existing) {
    existing.name = name.trim();
  } else {
    throw new Error(`There is no set ${JSON.stringify(id)}`);
  }
}

async function applyTexts(
  library: StoredLibrary,
  paths: LibraryPaths,
  change: InstructionsChange,
): Promise<void> {
  for (const [id, text] of Object.entries(change.texts ?? {})) {
    if (!instructionSets(library).some((set) => set.id === id)) {
      throw new Error(`There is no set ${JSON.stringify(id)}`);
    }
    await writeText(instructionSetPath(paths, id), text);
  }
  if (change.shared !== undefined) {
    await writeText(instructionSetPath(paths, activeInstructionSet(library)), change.shared);
  }
}

async function applyRemoval(
  library: StoredLibrary,
  paths: LibraryPaths,
  change: InstructionsChange,
): Promise<void> {
  const id = change.remove;
  if (!id) {
    return;
  }
  if (id === DEFAULT_SET_ID) {
    throw new Error("The first set can be renamed and emptied, not removed");
  }
  if (!instructionSets(library).some((set) => set.id === id)) {
    throw new Error(`There is no set ${JSON.stringify(id)}`);
  }
  if (id === activeInstructionSet(library)) {
    throw new Error("The set the agents get can't be removed: switch them to another first");
  }
  await writeText(instructionSetPath(paths, id), "");
  library.instructions.sets = library.instructions.sets.filter((set) => set.id !== id);
}

async function applyAgentsAndExtras(
  library: StoredLibrary,
  paths: LibraryPaths,
  change: InstructionsChange,
): Promise<void> {
  if (change.agents) {
    library.instructions.agents = [...new Set(change.agents)].sort();
  }
  for (const [agent, text] of Object.entries(change.extra ?? {})) {
    await writeText(agentExtraPath(paths, agent), text);
  }
}

/**
 * An empty set in use gives the agents nothing, so a set added, or one
 * given text, is the one they read from then on (myna #106).
 */
async function applyImplicitActivation(
  library: StoredLibrary,
  paths: LibraryPaths,
  change: InstructionsChange,
): Promise<void> {
  if (change.activate !== undefined || change.shared !== undefined) {
    return;
  }
  const current = await readText(instructionSetPath(paths, activeInstructionSet(library)));
  if (current.length > 0) {
    return;
  }
  if (change.create) {
    library.instructions.active = change.create.id;
  }
  for (const id of Object.keys(change.texts ?? {}).sort()) {
    if ((change.texts?.[id] ?? "").trim().length > 0 && id !== activeInstructionSet(library)) {
      library.instructions.active = id;
      break;
    }
  }
  if (library.instructions.active === DEFAULT_SET_ID) {
    library.instructions.active = "";
  }
}

function applyExplicitActivation(library: StoredLibrary, change: InstructionsChange): void {
  const activate = change.activate;
  if (activate === undefined || activate.length === 0) {
    return;
  }
  if (!instructionSets(library).some((set) => set.id === activate)) {
    throw new Error(`There is no set ${JSON.stringify(activate)}`);
  }
  library.instructions.active = activate === DEFAULT_SET_ID ? "" : activate;
}

async function applyImportOwn(
  library: StoredLibrary,
  paths: LibraryPaths,
  change: InstructionsChange,
  targets: readonly LibraryAgentTarget[],
  backup: LibraryBackup | undefined,
): Promise<void> {
  const agents = change.importOwn ?? [];
  if (agents.length === 0) {
    return;
  }
  const enabled = new Set(library.instructions.agents);
  const setPath = instructionSetPath(paths, activeInstructionSet(library));
  let shared = await readText(setPath);
  let moved = false;
  for (const agent of agents) {
    const target = targets.find((entry) => entry.id === agent);
    if (!target?.instructionsPath) {
      continue;
    }
    const file = (await readText(target.instructionsPath)).replace(/\r\n/g, "\n");
    const split = splitInstructionFile(file);
    const own = (split.hasBlock ? `${split.before}\n${split.after}` : file).trim();
    if (own.length === 0) {
      enabled.add(agent);
      continue;
    }
    shared = shared.trim().length === 0 ? own : `${shared.trim()}\n\n${own}`;
    moved = true;
    enabled.add(agent);
    if (backup) {
      await backup.keep(agent, target.instructionsPath);
    }
    // The text now lives in the shared set, so the file keeps only the
    // library's block; the next sync fills it.
    const remainder = split.hasBlock ? `${BLOCK_BEGIN}\n${split.block}\n${BLOCK_END}\n` : "";
    await writeManagedFile(target.instructionsPath, remainder);
  }
  library.instructions.agents = [...enabled].sort();
  if (moved) {
    await writeText(setPath, `${shared.trim()}\n`);
  }
}

function applyRewrite(library: StoredLibrary, change: InstructionsChange): void {
  for (const agent of change.rewrite ?? []) {
    const applied = (library.applied[agent] ??= {});
    applied.instrHash = "";
  }
}

export async function applyInstructionsChange(
  library: StoredLibrary,
  paths: LibraryPaths,
  change: InstructionsChange,
  options: { targets?: readonly LibraryAgentTarget[]; backup?: LibraryBackup } = {},
): Promise<void> {
  applyCreateOrRename(library, change);
  await applyTexts(library, paths, change);
  await applyRemoval(library, paths, change);
  await applyAgentsAndExtras(library, paths, change);
  await applyImplicitActivation(library, paths, change);
  applyExplicitActivation(library, change);
  await applyImportOwn(library, paths, change, options.targets ?? [], options.backup);
  applyRewrite(library, change);
}

/**
 * Writes an agent's part as the library has it.
 *
 * A part the user edited in the file is left alone until the library's
 * text for that agent changes; then it is replaced, the file kept aside
 * first.
 */
export async function syncInstructions(
  library: StoredLibrary,
  paths: LibraryPaths,
  context: AgentSyncContext,
): Promise<void> {
  const { target, backup, result } = context;
  const agent = target.id;
  if (!target.instructionsPath) {
    return;
  }
  const applied = (library.applied[agent] ??= {});
  const wanted = await wantedInstructions(library, paths, agent);
  let raw = "";
  try {
    raw = await readFile(target.instructionsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(result, agent, "instructions", error);
      return;
    }
  }
  const file = raw.replace(/\r\n/g, "\n");
  const split = splitInstructionFile(file);
  if (wanted.length === 0 && !split.hasBlock) {
    applied.instructions = false;
    applied.instrHash = "";
    return;
  }
  if (split.hasBlock && split.block === wanted) {
    applied.instructions = wanted.length > 0;
    applied.instrHash = wanted.length > 0 ? hashText(wanted) : "";
    return;
  }
  if (
    split.hasBlock &&
    wanted.length > 0 &&
    applied.instrHash &&
    hashText(split.block) !== applied.instrHash &&
    hashText(wanted) === applied.instrHash
  ) {
    return; // edited in the file since, and the library hasn't changed for it
  }
  const next = withInstructionBlock(file, wanted);
  try {
    await backup.keep(agent, target.instructionsPath);
    if (next.trim().length === 0) {
      await rm(target.instructionsPath, { force: true });
    } else {
      await writeManagedFile(target.instructionsPath, next);
    }
  } catch (error) {
    fail(result, agent, "instructions", error);
    return;
  }
  applied.instructions = wanted.length > 0;
  applied.instrHash = wanted.length > 0 ? hashText(wanted) : "";
  markChanged(result, agent);
}
