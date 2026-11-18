import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const NeolixServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.range !== undefined || value.portScript !== undefined,
    "Expected range or portScript",
  )
  .refine((value) => {
    if (!value.range) return true;
    const match = TCP_PORT_RANGE_PATTERN.exec(value.range);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= 1 && end <= 65_535 && start <= end;
  }, "Expected an inclusive TCP port range from 1-65535");

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter((command): command is string => {
    return typeof command === "string" && command.trim().length > 0;
  });
}

export const NeolixLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const NeolixScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const NeolixWorktreeConfigRawSchema = z
  .object({
    setup: NeolixLifecycleCommandRawSchema.optional(),
    teardown: NeolixLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    servicePorts: NeolixServicePortAllocationSchema.optional(),
  })
  .passthrough();

export const NeolixMetadataGenerationEntrySchema = z
  .object({
    instructions: z.string().optional(),
  })
  .passthrough()
  .catch({});

export const NeolixMetadataGenerationSchema = z
  .object({
    title: NeolixMetadataGenerationEntrySchema.optional(),
    branchName: NeolixMetadataGenerationEntrySchema.optional(),
    commitMessage: NeolixMetadataGenerationEntrySchema.optional(),
    pullRequest: NeolixMetadataGenerationEntrySchema.optional(),
  })
  // COMPAT(projectMetadataAgentTitle): `agentTitle` project metadata prompts were removed
  // in v0.1.96; keep unknown keys parseable until 2026-12-16.
  .passthrough()
  .catch({});

export const NeolixConfigRawSchema = z
  .object({
    worktree: NeolixWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), NeolixScriptEntryRawSchema).optional(),
    metadataGeneration: NeolixMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = NeolixWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = NeolixScriptEntryRawSchema.catch({});

export const NeolixConfigSchema = NeolixConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: NeolixMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export const NeolixConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
  /** Content hash; absent on tokens minted by daemons before it existed. */
  digest: z.string().optional(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: NeolixConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type NeolixScriptEntryRaw = z.infer<typeof NeolixScriptEntryRawSchema>;
export type NeolixMetadataGenerationEntry = z.infer<typeof NeolixMetadataGenerationEntrySchema>;
export type NeolixMetadataGeneration = z.infer<typeof NeolixMetadataGenerationSchema>;
export type NeolixServicePortAllocation = z.infer<typeof NeolixServicePortAllocationSchema>;
export type NeolixConfigRaw = z.infer<typeof NeolixConfigRawSchema>;
export type NeolixConfig = z.infer<typeof NeolixConfigSchema>;
export type NeolixConfigRevision = z.infer<typeof NeolixConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
