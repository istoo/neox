import { z } from "zod";

/**
 * Wire schemas for Settings → Use → Library.
 *
 * The library keeps one shared set of instructions, MCP servers, skills,
 * hooks and subagents, and writes each into the agents ticked for it. Every
 * write touches only what Neolix wrote, and keeps the file aside first.
 */

export const LibraryTransportSchema = z.enum(["stdio", "http", "sse"]);

/** A remote server's OAuth sign-in, as the page shows it (myna's
 * mcpauth.Status, internal/mcpauth/mcpauth.go:215). */
export const LibraryMcpSignInStatusSchema = z.object({
  signedIn: z.boolean(),
  dead: z.boolean().optional(),
  at: z.number().optional(),
});

export const LibraryMcpServerSchema = z.object({
  name: z.string().min(1),
  transport: LibraryTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  agents: z.array(z.string()),
  disabledTools: z.array(z.string()).optional(),
  signIn: LibraryMcpSignInStatusSchema.optional(),
  oauth: z
    .object({
      clientId: z.string(),
      clientSecret: z.string().optional(),
      callbackPort: z.number().int().nonnegative().optional(),
    })
    .optional(),
  startupTimeout: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  icon: z.string().optional(),
  /** Kept to this computer: a sync or a backup never carries it. */
  local: z.boolean().optional(),
  /** With the router on, each agent keeps its own entry instead. */
  router: z.enum(["shared", "direct"]).optional(),
});

export const LibraryMcpHealthSchema = z.object({
  ok: z.boolean(),
  tools: z.array(z.string()),
  error: z.string().optional(),
  ms: z.number().nonnegative(),
});

export const LibraryHookSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  event: z.string().min(1),
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  agents: z.array(z.string()),
});

export const LibrarySubagentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  skills: z.array(z.string()).optional(),
  mcp: z.array(z.string()).optional(),
  agents: z.array(z.string()),
});

export const LibraryAgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  instructionsPath: z.string(),
  mcpPath: z.string().nullable(),
  skillsDir: z.string().nullable(),
  hooksPath: z.string().nullable(),
  subagentsDir: z.string().nullable(),
  /** The WSL distro it lives in, when it is one of a distro's agents. */
  distro: z.string().optional(),
});

export const LibraryInstructionSetViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
  active: z.boolean(),
});

export const LibraryAgentInstructionsViewSchema = z.object({
  agent: z.string(),
  name: z.string(),
  icon: z.string(),
  path: z.string(),
  on: z.boolean(),
  extra: z.string(),
  own: z.number().int().nonnegative(),
  edited: z.boolean(),
  override: z.string().optional(),
});

export const LibraryInstructionsViewSchema = z.object({
  shared: z.string(),
  sets: z.array(LibraryInstructionSetViewSchema),
  agents: z.array(LibraryAgentInstructionsViewSchema),
});

export const LibrarySkillSourceSchema = z.object({
  kind: z.enum(["folder", "git", "github"]),
  repo: z.string().optional(),
  ref: z.string().optional(),
  path: z.string().optional(),
  dir: z.string().optional(),
});

export const LibrarySkillViewSchema = z.object({
  name: z.string(),
  description: z.string(),
  agents: z.array(z.string()),
  path: z.string(),
  note: z.string().optional(),
  source: LibrarySkillSourceSchema.optional(),
  hash: z.string().optional(),
  commit: z.string().optional(),
  gone: z.boolean().optional(),
  modified: z.boolean().optional(),
  /** Turned off on this computer alone; every other computer keeps it. */
  offHere: z.boolean().optional(),
  /** Its entry in ~/.agents/skills when the library's folder is kept there. */
  shared: z.string().optional(),
  /** That entry only links to a folder kept elsewhere; only the link goes. */
  sharedElsewhere: z.boolean().optional(),
  /** Agents that read ~/.agents/skills themselves, so they have it anyway. */
  always: z.array(z.string()).optional(),
});

export const LibrarySnapshotSchema = z.object({
  dir: z.string(),
  backupsDir: z.string(),
  homeDir: z.string(),
  agents: z.array(LibraryAgentViewSchema),
  instructions: LibraryInstructionsViewSchema,
  mcp: z.array(LibraryMcpServerSchema),
  skills: z.array(LibrarySkillViewSchema),
  hooks: z.array(LibraryHookSchema),
  subagents: z.array(LibrarySubagentSchema),
  mcpHub: z.boolean().optional(),
  skillOptions: z
    .object({
      copySkills: z.boolean(),
      skillHow: z.record(z.string(), z.enum(["link", "copy"])),
      sharedSkills: z.boolean(),
    })
    .optional(),
  counts: z.object({
    mcp: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    rtk: z.number().int().nonnegative(),
  }),
});

export const LibraryProblemSchema = z.object({
  agent: z.string(),
  what: z.string(),
  error: z.string(),
  /** A skill the agent has a folder of its own for, not the library's. */
  own: z.boolean().optional(),
});

export const LibrarySyncResultSchema = z.object({
  changed: z.array(z.string()),
  problems: z.array(LibraryProblemSchema),
  backup: z.string().optional(),
});

export const LibraryGetRequestSchema = z.object({
  type: z.literal("library.get.request"),
  requestId: z.string(),
});

/** Writes the library into every agent again. */
export const LibrarySyncRequestSchema = z.object({
  type: z.literal("library.sync.request"),
  requestId: z.string(),
});

/**
 * The skill moves that touch this computer's folders: turning one off here,
 * handing `~/.agents/skills` folders to the library and back, and settling
 * an agent's own skill against the library's.
 */
export const LibrarySkillControlRequestSchema = z.object({
  type: z.literal("library.skill.control.request"),
  requestId: z.string(),
  action: z.enum(["here", "handover", "handback", "settle"]),
  name: z.string().optional(),
  names: z.array(z.string()).optional(),
  /** Hand every skill in the library over. */
  all: z.boolean().optional(),
  agent: z.string().optional(),
  /** here: true turns it on here, false off. */
  on: z.boolean().optional(),
  /** settle: keep the agent's own skill instead of the library's. */
  keepOwn: z.boolean().optional(),
});

export const LibraryInstructionsSaveRequestSchema = z.object({
  type: z.literal("library.instructions.save.request"),
  requestId: z.string(),
  shared: z.string().optional(),
  agents: z.array(z.string()).optional(),
  extra: z.record(z.string(), z.string()).optional(),
  texts: z.record(z.string(), z.string()).optional(),
  activate: z.string().optional(),
  create: z.object({ id: z.string(), name: z.string() }).optional(),
  rename: z.object({ id: z.string(), name: z.string() }).optional(),
  remove: z.string().optional(),
  importOwn: z.array(z.string()).optional(),
  rewrite: z.array(z.string()).optional(),
});

export const LibraryMcpSaveRequestSchema = z.object({
  type: z.literal("library.mcp.save.request"),
  requestId: z.string(),
  /** The server's name before a rename; omitted when adding. */
  oldName: z.string().optional(),
  server: LibraryMcpServerSchema,
});

export const LibraryMcpRemoveRequestSchema = z.object({
  type: z.literal("library.mcp.remove.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibraryMcpHubRequestSchema = z.object({
  type: z.literal("library.mcp.hub.request"),
  requestId: z.string(),
  on: z.boolean(),
});

export const LibraryMcpHealthRequestSchema = z.object({
  type: z.literal("library.mcp.health.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibraryMcpSetAgentsRequestSchema = z.object({
  type: z.literal("library.mcp.set_agents.request"),
  requestId: z.string(),
  name: z.string(),
  agents: z.array(z.string()),
});

/** Where a sign-in stands: the page opens `url` and follows `id`. */
export const LibraryMcpSignInStateSchema = z.object({
  id: z.string(),
  server: z.string(),
  url: z.string().optional(),
  state: z.enum(["waiting", "done", "failed", "canceled"]),
  error: z.string().optional(),
});

export const LibraryMcpSignInRequestSchema = z.object({
  type: z.literal("library.mcp.signin.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibraryMcpSignInStatusRequestSchema = z.object({
  type: z.literal("library.mcp.signin_status.request"),
  requestId: z.string(),
  id: z.string(),
});

export const LibraryMcpSignInCancelRequestSchema = z.object({
  type: z.literal("library.mcp.signin_cancel.request"),
  requestId: z.string(),
  id: z.string(),
});

export const LibraryMcpSignOutRequestSchema = z.object({
  type: z.literal("library.mcp.signout.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibrarySkillImportRequestSchema = z.object({
  type: z.literal("library.skill.import.request"),
  requestId: z.string(),
  /** A folder holding the skill: copied into the library under its name. */
  path: z.string().min(1),
});

export const LibrarySkillRemoveRequestSchema = z.object({
  type: z.literal("library.skill.remove.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibrarySkillSetAgentsRequestSchema = z.object({
  type: z.literal("library.skill.set_agents.request"),
  requestId: z.string(),
  name: z.string(),
  agents: z.array(z.string()),
});

export const LibrarySkillFindRequestSchema = z.object({
  type: z.literal("library.skill.find.request"),
  requestId: z.string(),
  source: LibrarySkillSourceSchema,
});

export const LibrarySkillInstallRequestSchema = z.object({
  type: z.literal("library.skill.install.request"),
  requestId: z.string(),
  source: LibrarySkillSourceSchema,
  names: z.array(z.string()),
});

export const LibrarySkillOptionsRequestSchema = z.object({
  type: z.literal("library.skill.options.request"),
  requestId: z.string(),
  copySkills: z.boolean().optional(),
  skillHow: z.record(z.string(), z.enum(["link", "copy"])).optional(),
  sharedSkills: z.boolean().optional(),
});

export const LibrarySkillNoteRequestSchema = z.object({
  type: z.literal("library.skill.note.request"),
  requestId: z.string(),
  name: z.string(),
  note: z.string(),
});

export const LibrarySkillMarketHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  installs: z.number().nonnegative(),
  url: z.string(),
});

export const LibraryMarketInputSchema = z.object({
  key: z.string(),
  where: z.enum(["env", "header", "arg"]),
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
});

export const LibraryMarketServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  publisher: z.string().optional(),
  icon: z.string().optional(),
  homepage: z.string().optional(),
  transport: LibraryTransportSchema,
  runs: z.string().optional(),
  featured: z.boolean().optional(),
  /** No agent is picked for it until the user ticks one (myna's OptIn). */
  optIn: z.boolean().optional(),
  inputs: z.array(LibraryMarketInputSchema),
  have: z.string().optional(),
});

export const LibraryMarketServersRequestSchema = z.object({
  type: z.literal("library.market.servers.request"),
  requestId: z.string(),
  query: z.string(),
});

export const LibraryMarketInstallRequestSchema = z.object({
  type: z.literal("library.market.install.request"),
  requestId: z.string(),
  id: z.string(),
  values: z.record(z.string(), z.string()),
  agents: z.array(z.string()),
});

export const LibraryMarketSkillsRequestSchema = z.object({
  type: z.literal("library.market.skills.request"),
  requestId: z.string(),
  query: z.string(),
});

export const LibrarySkillCheckRequestSchema = z.object({
  type: z.literal("library.skill.check.request"),
  requestId: z.string(),
});

export const LibrarySkillUpdateRequestSchema = z.object({
  type: z.literal("library.skill.update.request"),
  requestId: z.string(),
  names: z.array(z.string()).nullable(),
});

export const LibraryHookSaveRequestSchema = z.object({
  type: z.literal("library.hook.save.request"),
  requestId: z.string(),
  oldName: z.string().optional(),
  hook: LibraryHookSchema,
});

export const LibraryHookRemoveRequestSchema = z.object({
  type: z.literal("library.hook.remove.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibraryHookSetAgentsRequestSchema = z.object({
  type: z.literal("library.hook.set_agents.request"),
  requestId: z.string(),
  name: z.string(),
  agents: z.array(z.string()),
});

export const LibrarySubagentSaveRequestSchema = z.object({
  type: z.literal("library.subagent.save.request"),
  requestId: z.string(),
  oldName: z.string().optional(),
  subagent: LibrarySubagentSchema,
});

export const LibrarySubagentRemoveRequestSchema = z.object({
  type: z.literal("library.subagent.remove.request"),
  requestId: z.string(),
  name: z.string(),
});

export const LibrarySubagentSetAgentsRequestSchema = z.object({
  type: z.literal("library.subagent.set_agents.request"),
  requestId: z.string(),
  name: z.string(),
  agents: z.array(z.string()),
});

export const LibraryRtkGetRequestSchema = z.object({
  type: z.literal("library.rtk.get.request"),
  requestId: z.string(),
});

export const LibraryRtkSetRequestSchema = z.object({
  type: z.literal("library.rtk.set.request"),
  requestId: z.string(),
  agent: z.string(),
  on: z.boolean(),
});

const libraryPayload = (extra: z.ZodRawShape) =>
  z
    .object({
      requestId: z.string(),
      ...extra,
    })
    .passthrough();

export const LibraryGithubTokenGetRequestSchema = z.object({
  type: z.literal("library.github_token.get.request"),
  requestId: z.string(),
});

export const LibraryGithubTokenGetResponseSchema = z.object({
  type: z.literal("library.github_token.get.response"),
  payload: z
    .object({
      requestId: z.string(),
      /** Whether a token is stored; the token itself never leaves the host. */
      configured: z.boolean(),
      /** GitHub answered 401 to the Settings token, which needs replacing. */
      rejected: z.boolean().optional(),
      /** When that refusal happened. */
      rejectedAt: z.string().optional(),
    })
    .passthrough(),
});

export const LibraryGithubTokenSetRequestSchema = z.object({
  type: z.literal("library.github_token.set.request"),
  requestId: z.string(),
  /** The new token; empty clears the stored one. */
  token: z.string(),
});

export const LibraryGithubTokenSetResponseSchema = z.object({
  type: z.literal("library.github_token.set.response"),
  payload: z.object({ requestId: z.string(), configured: z.boolean() }).passthrough(),
});

export const LibraryMarketSkillsResponseSchema = z.object({
  type: z.literal("library.market.skills.response"),
  payload: libraryPayload({ skills: z.array(LibrarySkillMarketHitSchema) }),
});

export const LibraryMarketServersResponseSchema = z.object({
  type: z.literal("library.market.servers.response"),
  payload: libraryPayload({
    servers: z.array(LibraryMarketServerSchema),
    error: z.string().optional(),
  }),
});

export const LibraryGetResponseSchema = z.object({
  type: z.literal("library.get.response"),
  payload: libraryPayload({ library: LibrarySnapshotSchema }),
});

export const LibraryMutationResponseSchema = <const T extends string>(type: T) =>
  z.object({
    type: z.literal(type),
    payload: libraryPayload({
      library: LibrarySnapshotSchema,
      result: LibrarySyncResultSchema,
    }),
  });

export const LibraryMcpHubResponseSchema = LibraryMutationResponseSchema(
  "library.mcp.hub.response",
);
export const LibrarySyncResponseSchema = LibraryMutationResponseSchema("library.sync.response");
export const LibrarySkillControlResponseSchema = LibraryMutationResponseSchema(
  "library.skill.control.response",
);
export const LibraryMarketInstallResponseSchema = LibraryMutationResponseSchema(
  "library.market.install.response",
);
export const LibraryInstructionsSaveResponseSchema = LibraryMutationResponseSchema(
  "library.instructions.save.response",
);
export const LibraryMcpSaveResponseSchema = LibraryMutationResponseSchema(
  "library.mcp.save.response",
);
export const LibraryMcpRemoveResponseSchema = LibraryMutationResponseSchema(
  "library.mcp.remove.response",
);
export const LibraryMcpSetAgentsResponseSchema = LibraryMutationResponseSchema(
  "library.mcp.set_agents.response",
);
export const LibrarySkillImportResponseSchema = LibraryMutationResponseSchema(
  "library.skill.import.response",
);
export const LibrarySkillRemoveResponseSchema = LibraryMutationResponseSchema(
  "library.skill.remove.response",
);
export const LibrarySkillSetAgentsResponseSchema = LibraryMutationResponseSchema(
  "library.skill.set_agents.response",
);
export const LibraryMcpHealthResponseSchema = z.object({
  type: z.literal("library.mcp.health.response"),
  payload: libraryPayload({ health: LibraryMcpHealthSchema }),
});

export const LibraryMcpSignInResponseSchema = z.object({
  type: z.literal("library.mcp.signin.response"),
  payload: libraryPayload({ state: LibraryMcpSignInStateSchema }),
});

export const LibraryMcpSignInStatusResponseSchema = z.object({
  type: z.literal("library.mcp.signin_status.response"),
  payload: libraryPayload({ state: LibraryMcpSignInStateSchema.optional() }),
});

export const LibraryMcpSignInCancelResponseSchema = z.object({
  type: z.literal("library.mcp.signin_cancel.response"),
  payload: libraryPayload({}),
});

export const LibraryMcpSignOutResponseSchema = LibraryMutationResponseSchema(
  "library.mcp.signout.response",
);

export const LibrarySkillFindResponseSchema = z.object({
  type: z.literal("library.skill.find.response"),
  payload: libraryPayload({
    candidates: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        path: z.string(),
        hash: z.string(),
      }),
    ),
  }),
});
export const LibrarySkillInstallResponseSchema = LibraryMutationResponseSchema(
  "library.skill.install.response",
);
export const LibrarySkillOptionsResponseSchema = LibraryMutationResponseSchema(
  "library.skill.options.response",
);
export const LibrarySkillNoteResponseSchema = LibraryMutationResponseSchema(
  "library.skill.note.response",
);
export const LibrarySkillCheckResponseSchema = z.object({
  type: z.literal("library.skill.check.response"),
  payload: libraryPayload({
    updates: z.array(z.object({ name: z.string(), available: z.boolean(), gone: z.boolean() })),
  }),
});
export const LibrarySkillUpdateResponseSchema = LibraryMutationResponseSchema(
  "library.skill.update.response",
);
export const LibraryHookSaveResponseSchema = LibraryMutationResponseSchema(
  "library.hook.save.response",
);
export const LibraryHookRemoveResponseSchema = LibraryMutationResponseSchema(
  "library.hook.remove.response",
);
export const LibraryHookSetAgentsResponseSchema = LibraryMutationResponseSchema(
  "library.hook.set_agents.response",
);
export const LibrarySubagentSaveResponseSchema = LibraryMutationResponseSchema(
  "library.subagent.save.response",
);
export const LibrarySubagentRemoveResponseSchema = LibraryMutationResponseSchema(
  "library.subagent.remove.response",
);
export const LibrarySubagentSetAgentsResponseSchema = LibraryMutationResponseSchema(
  "library.subagent.set_agents.response",
);

export const LibraryRtkAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  on: z.boolean(),
  /** The WSL distro it lives in, when it is one of a distro's agents. */
  distro: z.string().optional(),
});

export const LibraryRtkDistroSchema = z.object({
  distro: z.string(),
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
});

export const LibraryRtkStatusSchema = z.object({
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  url: z.string(),
  installCommand: z.string().optional(),
  upgradeCommand: z.string().optional(),
  pathHint: z.string().optional(),
  /** Each WSL distro an agent lives in, and its own RTK. */
  distros: z.array(LibraryRtkDistroSchema).optional(),
  agents: z.array(LibraryRtkAgentSchema),
});

export const LibraryRtkRunSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  output: z.string(),
  error: z.string().optional(),
});

export const LibraryRtkGainSchema = z.object({
  available: z.boolean(),
  raw: z.string(),
  total: z.number().nullable(),
  days: z.array(z.object({ date: z.string(), value: z.number() })),
});

export const LibraryRtkRunRequestSchema = z.object({
  type: z.literal("library.rtk.run.request"),
  requestId: z.string(),
  action: z.enum(["install", "upgrade"]),
  confirm: z.boolean(),
  /** A WSL distro to install or upgrade RTK in, for the agents there. */
  distro: z.string().optional(),
});

export const LibraryRtkGainRequestSchema = z.object({
  type: z.literal("library.rtk.gain.request"),
  requestId: z.string(),
});

export const LibraryRtkRunResponseSchema = z.object({
  type: z.literal("library.rtk.run.response"),
  payload: libraryPayload({ rtk: LibraryRtkStatusSchema, run: LibraryRtkRunSchema }),
});

export const LibraryRtkGainResponseSchema = z.object({
  type: z.literal("library.rtk.gain.response"),
  payload: libraryPayload({ gain: LibraryRtkGainSchema }),
});

export const LibraryRtkGetResponseSchema = z.object({
  type: z.literal("library.rtk.get.response"),
  payload: libraryPayload({ rtk: LibraryRtkStatusSchema }),
});

export const LibraryRtkSetResponseSchema = z.object({
  type: z.literal("library.rtk.set.response"),
  payload: libraryPayload({ rtk: LibraryRtkStatusSchema }),
});

export const LibraryFoundMcpServerSchema = LibraryMcpServerSchema.extend({
  otherAgents: z.array(z.string()),
  /** The agent's app writes this server itself on every start (myna's Own). */
  own: z.boolean().optional(),
});

export const LibraryFoundSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  agents: z.array(z.string()),
  otherAgents: z.array(z.string()),
});

export const LibraryDiscoverViewSchema = z.object({
  servers: z.array(LibraryFoundMcpServerSchema),
  skills: z.array(LibraryFoundSkillSchema),
});

export const LibraryMynaLibraryViewSchema = z.object({
  dir: z.string(),
  available: z.boolean(),
  servers: z.array(LibraryFoundMcpServerSchema),
  skills: z.array(LibraryFoundSkillSchema),
});

export const LibraryBackupFileSchema = z.object({
  file: z.string(),
  size: z.number().int().nonnegative(),
  target: z.string().nullable(),
});

export const LibraryBackupSessionSchema = z.object({
  stamp: z.string(),
  files: z.record(z.string(), z.array(LibraryBackupFileSchema)),
});

export const LibraryDiscoverGetRequestSchema = z.object({
  type: z.literal("library.discover.get.request"),
  requestId: z.string(),
});

export const LibraryDiscoverImportRequestSchema = z.object({
  type: z.literal("library.discover.import.request"),
  requestId: z.string(),
  servers: z.array(z.string()),
  skills: z.array(z.string()),
});

export const LibraryDiscoverRemoveRequestSchema = z.object({
  type: z.literal("library.discover.remove.request"),
  requestId: z.string(),
  servers: z.array(z.string()),
  skills: z.array(z.string()),
});

export const LibraryMynaGetRequestSchema = z.object({
  type: z.literal("library.myna.get.request"),
  requestId: z.string(),
});

export const LibraryMynaImportRequestSchema = z.object({
  type: z.literal("library.myna.import.request"),
  requestId: z.string(),
  servers: z.array(z.string()),
  skills: z.array(z.string()),
});

export const LibraryBackupListRequestSchema = z.object({
  type: z.literal("library.backup.list.request"),
  requestId: z.string(),
});

export const LibraryBackupRestoreRequestSchema = z.object({
  type: z.literal("library.backup.restore.request"),
  requestId: z.string(),
  stamp: z.string().min(1),
  agent: z.string().min(1),
  file: z.string().min(1),
});

export const LibraryDiscoverGetResponseSchema = z.object({
  type: z.literal("library.discover.get.response"),
  payload: libraryPayload({ discover: LibraryDiscoverViewSchema }),
});

export const LibraryDiscoverImportResponseSchema = LibraryMutationResponseSchema(
  "library.discover.import.response",
);
export const LibraryDiscoverRemoveResponseSchema = LibraryMutationResponseSchema(
  "library.discover.remove.response",
);
export const LibraryMynaGetResponseSchema = z.object({
  type: z.literal("library.myna.get.response"),
  payload: libraryPayload({ myna: LibraryMynaLibraryViewSchema }),
});
export const LibraryMynaImportResponseSchema = LibraryMutationResponseSchema(
  "library.myna.import.response",
);
export const LibraryBackupListResponseSchema = z.object({
  type: z.literal("library.backup.list.response"),
  payload: libraryPayload({ backups: z.array(LibraryBackupSessionSchema) }),
});
export const LibraryBackupRestoreResponseSchema = z.object({
  type: z.literal("library.backup.restore.response"),
  payload: libraryPayload({ library: LibrarySnapshotSchema, restored: z.string() }),
});

export type LibraryTransport = z.infer<typeof LibraryTransportSchema>;
export type LibraryMcpServer = z.infer<typeof LibraryMcpServerSchema>;
export type LibraryMcpHealth = z.infer<typeof LibraryMcpHealthSchema>;
export type LibraryMcpSignInStatus = z.infer<typeof LibraryMcpSignInStatusSchema>;
export type LibraryMcpSignInState = z.infer<typeof LibraryMcpSignInStateSchema>;
export type LibraryHook = z.infer<typeof LibraryHookSchema>;
export type LibrarySubagent = z.infer<typeof LibrarySubagentSchema>;
export type LibraryAgentView = z.infer<typeof LibraryAgentViewSchema>;
export type LibraryInstructionsView = z.infer<typeof LibraryInstructionsViewSchema>;
export type LibrarySkillView = z.infer<typeof LibrarySkillViewSchema>;
export type LibrarySkillSource = z.infer<typeof LibrarySkillSourceSchema>;
export type LibrarySkillMarketHit = z.infer<typeof LibrarySkillMarketHitSchema>;
export type LibraryMarketServer = z.infer<typeof LibraryMarketServerSchema>;
export type LibraryMarketInput = z.infer<typeof LibraryMarketInputSchema>;
export type LibrarySnapshot = z.infer<typeof LibrarySnapshotSchema>;
export type LibraryProblem = z.infer<typeof LibraryProblemSchema>;
export type LibrarySyncResult = z.infer<typeof LibrarySyncResultSchema>;
export type LibraryMutationPayload = z.infer<typeof LibraryMcpSaveResponseSchema>["payload"];
export type LibraryRtkStatus = z.infer<typeof LibraryRtkStatusSchema>;
export type LibraryRtkRun = z.infer<typeof LibraryRtkRunSchema>;
export type LibraryRtkGain = z.infer<typeof LibraryRtkGainSchema>;
export type LibraryGetRequest = z.infer<typeof LibraryGetRequestSchema>;
export type LibrarySyncRequest = z.infer<typeof LibrarySyncRequestSchema>;
export type LibrarySkillControlRequest = z.infer<typeof LibrarySkillControlRequestSchema>;
export type LibraryInstructionsSaveRequest = z.infer<typeof LibraryInstructionsSaveRequestSchema>;
export type LibraryMcpSaveRequest = z.infer<typeof LibraryMcpSaveRequestSchema>;
export type LibrarySkillImportRequest = z.infer<typeof LibrarySkillImportRequestSchema>;
export type LibraryHookSaveRequest = z.infer<typeof LibraryHookSaveRequestSchema>;
export type LibrarySubagentSaveRequest = z.infer<typeof LibrarySubagentSaveRequestSchema>;
export type LibraryRtkSetRequest = z.infer<typeof LibraryRtkSetRequestSchema>;
export type LibraryFoundMcpServer = z.infer<typeof LibraryFoundMcpServerSchema>;
export type LibraryFoundSkill = z.infer<typeof LibraryFoundSkillSchema>;
export type LibraryDiscoverView = z.infer<typeof LibraryDiscoverViewSchema>;
export type LibraryMynaLibraryView = z.infer<typeof LibraryMynaLibraryViewSchema>;
export type LibraryBackupFile = z.infer<typeof LibraryBackupFileSchema>;
export type LibraryBackupSession = z.infer<typeof LibraryBackupSessionSchema>;
export type LibraryDiscoverGetRequest = z.infer<typeof LibraryDiscoverGetRequestSchema>;
export type LibraryDiscoverImportRequest = z.infer<typeof LibraryDiscoverImportRequestSchema>;
export type LibraryMynaGetRequest = z.infer<typeof LibraryMynaGetRequestSchema>;
export type LibraryMynaImportRequest = z.infer<typeof LibraryMynaImportRequestSchema>;
export type LibraryBackupListRequest = z.infer<typeof LibraryBackupListRequestSchema>;
export type LibraryBackupRestoreRequest = z.infer<typeof LibraryBackupRestoreRequestSchema>;
