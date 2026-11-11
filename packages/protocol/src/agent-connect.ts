import { z } from "zod";

/**
 * Wire shapes for Settings → Use → Agent: whether an installed agent's own
 * user config points at the daemon's LLM gateway, and the saved setups
 * ("profiles") that can restore a set of those choices at once.
 */

export const AgentConnectModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    // COMPAT(agentConnectModelMeta): added in v0.15.0, remove after 2027-11-05.
    /** The gateway's own catalog facts, for an agent's provider entry that carries them. */
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    kind: z.enum(["chat", "image", "video"]).optional(),
    /** Whether it accepts images; false means the gateway describes them in text first. */
    images: z.boolean().optional(),
  })
  .passthrough();

/** A provider whose user-level config Neolix knows how to write. */
export const AgentConnectProviderSchema = z.enum(["claude", "codex", "opencode", "pi"]);

export type AgentConnectProvider = z.infer<typeof AgentConnectProviderSchema>;

/**
 * Why a provider cannot be switched on. Absent (`null`) means it can.
 * `unsupported` covers agents that only use their own models, and agents
 * whose config Neolix has no writer for.
 */
export const AgentConnectReasonSchema = z.enum([
  "unsupported",
  "gateway_unavailable",
  "no_gateway_models",
]);

/**
 * `unwired`: the agent's config no longer points at Neolix. `stale`: it still
 * does, but through an old gateway address or a model the gateway dropped.
 * Null means the wiring is what Neolix last wrote (or was never written).
 */
export const AgentConnectDriftSchema = z.enum(["unwired", "stale"]);

export const AgentConnectEntrySchema = z
  .object({
    provider: z.string().min(1),
    /** The provider's config file as this host resolves it, for the details tooltip. */
    configPath: z.string().nullable(),
    connected: z.boolean(),
    /** The gateway model the agent starts on, or null for its own last pick. */
    model: z.string().nullable(),
    /** How many gateway models the agent's own model list carries. */
    modelCount: z.number().int().nonnegative(),
    /**
     * The agent's own settings drawn in its one row (Aside's four model
     * roles), each set as `provider#id`.
     */
    // COMPAT(agentConnectFields): added in v0.15.0, remove after 2027-11-06.
    fields: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string(),
            model: z.string().nullable(),
          })
          .passthrough(),
      )
      .optional(),
    /**
     * The agent's own settings as myna's `myna <agent> <field>` takes them:
     * what each reads as now and, for a pick, the values it accepts. Only
     * the fields Neolix can read and write are listed.
     */
    // COMPAT(agentConnectSettings): added in v0.15.0, remove after 2027-11-06.
    settings: z
      .array(
        z.object({
          key: z.string().min(1),
          label: z.string(),
          value: z.string(),
          options: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    /**
     * The gateway models this agent's own list carries and the ones it
     * leaves out (myna's HiddenModels per agent), for a connected row.
     */
    // COMPAT(agentConnectModels): added in v0.15.0, remove after 2027-11-06.
    models: z
      .object({
        listed: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
        hidden: z.array(z.string()),
      })
      .passthrough()
      .optional(),
    /** The version of the agent's own CLI, as it reports it, when Neolix could read it. */
    // COMPAT(agentConnectCliVersion): added in v0.15.0, remove after 2027-11-06.
    cliVersion: z.string().optional(),
    /**
     * Copies of the agent still running on the list they started with
     * (myna's StaleCopies): each is reopened or restarted to pick up the
     * config Neolix wrote.
     */
    // COMPAT(agentConnectStale): added in v0.15.0, remove after 2027-11-06.
    staleCopies: z
      .array(
        z.object({
          kind: z.enum(["app", "ide", "daemon", "cli"]),
          since: z.number(),
          bundle: z.string().optional(),
        }),
      )
      .optional(),
    reason: AgentConnectReasonSchema.nullable(),
    // COMPAT(agentConnectDrift): added in v0.15.0, remove after 2027-11-05.
    drift: AgentConnectDriftSchema.nullable().optional(),
    /**
     * A command that starts the agent on the gateway from its environment,
     * for CLIs Neolix cannot write a config for. Absent when not applicable.
     */
    // COMPAT(agentConnectLaunch): added in v0.15.0, remove after 2027-11-05.
    launchCommand: z.string().nullable().optional(),
    // COMPAT(agentConnectExternal): added in v0.15.0, remove after 2027-11-05.
    /**
     * `external` for an agent Neolix does not run itself, only wires to the
     * gateway; absent for Neolix's own providers.
     */
    kind: z.enum(["provider", "external"]).optional(),
    /** The agent's own name, for an external agent. */
    name: z.string().optional(),
    /** The agent's icon slug from myna's bundled set. */
    icon: z.string().optional(),
    // COMPAT(agentConnectShell): added in v0.15.0, remove after 2027-11-05.
    /** Whether Neolix's shell function for this agent is in the reader's profile. */
    shellInstalled: z.boolean().optional(),
    // COMPAT(agentConnectImportLink): added in v0.15.0, remove after 2027-11-05.
    /**
     * A deeplink the agent's own app takes to add Neolix as a provider, for an
     * agent that keeps its providers somewhere Neolix cannot write.
     */
    importLink: z.string().optional(),
  })
  .passthrough();

export const AgentConnectSetupSchema = z
  .object({
    connected: z.boolean(),
    model: z.string().nullable(),
  })
  .passthrough();

export const AgentConnectLibrarySchema = z
  .object({
    /** Library server name → the agents it is ticked for. */
    mcp: z.record(z.string(), z.array(z.string())).optional(),
    skills: z.record(z.string(), z.array(z.string())).optional(),
    hooks: z.record(z.string(), z.array(z.string())).optional(),
    subagents: z.record(z.string(), z.array(z.string())).optional(),
    /** The agents that take the library's instructions. */
    instructions: z.array(z.string()).optional(),
    /** Whether agents get Neolix's MCP hub in place of their own servers. */
    mcpHub: z.boolean().optional(),
  })
  .passthrough();

export const AgentConnectProfileSchema = z
  .object({
    name: z.string().min(1),
    savedAt: z.number(),
    agents: z.record(z.string(), AgentConnectSetupSchema),
    /** Who the library's MCP servers, skills, hooks and instructions went to. */
    library: AgentConnectLibrarySchema.optional(),
    /**
     * Whether the setup as it stands is this profile's; worked out when the
     * snapshot is read, never stored with the profile.
     */
    // COMPAT(agentConnectProfileInUse): added in v0.15.0, remove after 2027-11-06.
    inUse: z.boolean().optional(),
  })
  .passthrough();

/** A plugin that registers agent providers, for the 「More in Plugins」 row. */
export const AgentConnectPluginProviderSchema = z
  .object({
    pluginId: z.string().min(1),
    providers: z.array(z.string().min(1)),
  })
  .passthrough();

export const AgentConnectSnapshotSchema = z
  .object({
    /** The gateway's `/v1` origin as an agent on this host reaches it, or null. */
    gatewayBaseUrl: z.string().nullable(),
    models: z.array(AgentConnectModelSchema),
    entries: z.array(AgentConnectEntrySchema),
    profiles: z.array(AgentConnectProfileSchema),
    // COMPAT(agentConnectLayout): added in v0.15.0, remove after 2027-11-05.
    /** Provider ids in the order the reader arranged them. */
    order: z.array(z.string()).optional(),
    /** Provider ids the reader hid from the list. */
    hidden: z.array(z.string()).optional(),
    // COMPAT(agentConnectPluginProviders): added in v0.15.0, remove after 2027-11-05.
    /** Plugins on this host that contribute agent providers. */
    pluginProviders: z.array(AgentConnectPluginProviderSchema).optional(),
    /** A write or profile error to show; the rest of the snapshot is still valid. */
    error: z.string().nullable(),
  })
  .passthrough();

export const AgentConnectGetRequestSchema = z.object({
  type: z.literal("agent.connect.get.request"),
  requestId: z.string(),
});

export const AgentConnectGetResponseSchema = z.object({
  type: z.literal("agent.connect.get.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectSetRequestSchema = z.object({
  type: z.literal("agent.connect.set.request"),
  requestId: z.string(),
  provider: z.string().min(1),
  connected: z.boolean(),
  model: z.string().optional(),
  /**
   * One of the entry's `settings` to write, myna's `myna <agent> <field>
   * <value>`; with a field given, `connected` and `model` are ignored, and
   * an empty value puts the field back to the agent's own default.
   */
  // COMPAT(agentConnectSetField): added in v0.15.0, remove after 2027-11-06.
  field: z.string().min(1).optional(),
  value: z.string().optional(),
});

export const AgentConnectSetResponseSchema = z.object({
  type: z.literal("agent.connect.set.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectShellRequestSchema = z.object({
  type: z.literal("agent.connect.shell.request"),
  requestId: z.string(),
  provider: z.string().min(1),
  enabled: z.boolean(),
});

export const AgentConnectShellResponseSchema = z.object({
  type: z.literal("agent.connect.shell.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectProfileListRequestSchema = z.object({
  type: z.literal("agent.connect.profile.list.request"),
  requestId: z.string(),
});

export const AgentConnectProfileListResponseSchema = z.object({
  type: z.literal("agent.connect.profile.list.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectProfileSaveRequestSchema = z.object({
  type: z.literal("agent.connect.profile.save.request"),
  requestId: z.string(),
  name: z.string().min(1).max(80),
});

export const AgentConnectProfileSaveResponseSchema = z.object({
  type: z.literal("agent.connect.profile.save.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectProfileApplyRequestSchema = z.object({
  type: z.literal("agent.connect.profile.apply.request"),
  requestId: z.string(),
  name: z.string().min(1),
});

export const AgentConnectProfileApplyResponseSchema = z.object({
  type: z.literal("agent.connect.profile.apply.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectProfileDeleteRequestSchema = z.object({
  type: z.literal("agent.connect.profile.delete.request"),
  requestId: z.string(),
  name: z.string().min(1),
});

export const AgentConnectProfileDeleteResponseSchema = z.object({
  type: z.literal("agent.connect.profile.delete.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectProfileRenameRequestSchema = z.object({
  type: z.literal("agent.connect.profile.rename.request"),
  requestId: z.string(),
  name: z.string().min(1),
  to: z.string().min(1).max(80),
});

export const AgentConnectProfileRenameResponseSchema = z.object({
  type: z.literal("agent.connect.profile.rename.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

/** The gateway entries an agent's own model list leaves out (myna's HiddenModels). */
export const AgentConnectModelsRequestSchema = z.object({
  type: z.literal("agent.connect.models.request"),
  requestId: z.string(),
  provider: z.string().min(1),
  hidden: z.array(z.string()),
});

export const AgentConnectModelsResponseSchema = z.object({
  type: z.literal("agent.connect.models.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

/** Restarts one kind of running copy that is on the list it started with. */
export const AgentConnectStaleRestartRequestSchema = z.object({
  type: z.literal("agent.connect.stale.restart.request"),
  requestId: z.string(),
  provider: z.string().min(1),
  kind: z.enum(["app", "ide", "daemon", "cli"]),
});

export const AgentConnectStaleRestartResponseSchema = z.object({
  type: z.literal("agent.connect.stale.restart.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export const AgentConnectLayoutSetRequestSchema = z.object({
  type: z.literal("agent.connect.layout.set.request"),
  requestId: z.string(),
  order: z.array(z.string().min(1)),
  hidden: z.array(z.string().min(1)),
});

export const AgentConnectLayoutSetResponseSchema = z.object({
  type: z.literal("agent.connect.layout.set.response"),
  payload: z
    .object({
      requestId: z.string(),
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

/** Pushed to every connected client after any write, as `gateway.config.changed` is. */
export const AgentConnectChangedSchema = z.object({
  type: z.literal("agent.connect.changed"),
  payload: z
    .object({
      snapshot: AgentConnectSnapshotSchema,
    })
    .passthrough(),
});

export type AgentConnectDrift = z.infer<typeof AgentConnectDriftSchema>;
export type AgentConnectPluginProvider = z.infer<typeof AgentConnectPluginProviderSchema>;
export type AgentConnectEntry = z.infer<typeof AgentConnectEntrySchema>;
export type AgentConnectModel = z.infer<typeof AgentConnectModelSchema>;
export type AgentConnectProfile = z.infer<typeof AgentConnectProfileSchema>;
export type AgentConnectLibrary = z.infer<typeof AgentConnectLibrarySchema>;
export type AgentConnectSetup = z.infer<typeof AgentConnectSetupSchema>;
export type AgentConnectSnapshot = z.infer<typeof AgentConnectSnapshotSchema>;
