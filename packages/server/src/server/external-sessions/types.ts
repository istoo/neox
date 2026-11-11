/** One agent's session as Settings → Use → Sessions lists it. */
export interface ExternalSessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ExternalSessionModel {
  model: string;
  effort?: string;
  tokens: ExternalSessionTokens;
  cost: number;
  priced: boolean;
}

/** A gateway request's model pair: what the agent asked for and what served it. */
export interface ExternalSessionVia {
  requested: string;
  model: string;
  effort?: string;
}

export interface ExternalSubagent {
  id: string;
  title: string;
  kind: string;
  parent?: string;
  start?: string;
  last?: string;
}

/** One model's share of a day, as a transcript line names it. */
export interface ExternalSessionActivityModel {
  model: string;
  tokens: ExternalSessionTokens;
}

/** One local day's tokens and active time, read from the transcript. */
export interface ExternalSessionActivity {
  date: string;
  tokens: ExternalSessionTokens;
  activeSeconds: number;
  models?: ExternalSessionActivityModel[];
}

export interface ExternalSession {
  id: string;
  agent: string;
  cwd: string;
  title: string;
  start: string;
  last: string;
  messages: number;
  size: number;
  tokens: ExternalSessionTokens;
  models: ExternalSessionModel[];
  cost: number;
  priced: boolean;
  resume: string;
  path: string;
  deletable: boolean;
  /** Seen only through the gateway: the agent keeps no file of it here. */
  gateway?: boolean;
  via?: ExternalSessionVia[];
  subagents?: ExternalSubagent[];
  /** A Codex rollout's provider; empty for other agents. */
  provider?: string;
  /** The provider the Codex of its folder uses now, which its history lists. */
  usesProvider?: string;
  /** The WSL distro it ran in, on Windows; sessions here can't be resumed. */
  wsl?: string;
  /** Per-day tokens and active time, when the list asked for activity. */
  activity?: ExternalSessionActivity[];
}

export interface ExternalSessionAgent {
  agent: string;
  name: string;
  count: number;
  deletable: boolean;
}

export interface ExternalSessionTrashed {
  key: string;
  agent: string;
  id: string;
  title: string;
  cwd: string;
  last: string;
  deleted: string;
  size: number;
  gateway?: boolean;
}

export interface ExternalSessionRefusal {
  id: string;
  error: string;
  active: boolean;
}

export interface ExternalSessionPurgeRefusal {
  key: string;
  error: string;
}

/** What a session file's text says, read once per change. */
export interface SessionParse {
  title: string;
  cwd: string;
  start: string;
  last: string;
  messages: number;
  tokens: ExternalSessionTokens;
  models: ExternalSessionModel[];
  cost: number;
  priced: boolean;
  provider?: string;
}

export interface SessionFile {
  agent: string;
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** The WSL distro it was found in, on Windows. */
  wsl?: string;
}

export interface SessionRoots {
  claude: string;
  codex: string;
  pi: string;
  /** OpenCode's database; its sessions are rows, not files. */
  opencode: string;
  /** Antigravity CLI's data folder. */
  agy: string;
}
