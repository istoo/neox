import { z } from "zod";

/**
 * Wire shapes for installing an agent's command-line program: the catalog
 * is fixed by the daemon, and the client only names an entry. Commands run
 * on the daemon host, after the user confirmed the request in the UI.
 */

/** How a command is run, named in the UI: a vendor installer, brew, or npm. */
export const AgentInstallViaSchema = z.enum(["script", "powershell", "brew", "npm"]);

export const AgentInstallCommandSchema = z
  .object({
    /** Stable within one entry, e.g. `script`, `brew`. */
    id: z.string().min(1),
    via: AgentInstallViaSchema,
    /** The exact shell line, shown before it runs. */
    command: z.string().min(1),
  })
  .passthrough();

export const AgentInstallEntrySchema = z
  .object({
    provider: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    /** The vendor's page; the only action when `commands` is empty. */
    url: z.string().nullable(),
    commands: z.array(AgentInstallCommandSchema),
    /**
     * The vendor's uninstall lines for this host. Optional: it arrived with
     * `agent.install.uninstall`, and an older daemon doesn't send it.
     */
    uninstallCommands: z.array(AgentInstallCommandSchema).optional(),
    /**
     * True when Neolix ran this entry's installer (the daemon keeps the
     * record). Only such a copy may be uninstalled. Optional: older daemons
     * don't send it.
     */
    installed: z.boolean().optional(),
  })
  .passthrough();

export const AgentInstallListRequestSchema = z.object({
  type: z.literal("agent.install.list.request"),
  requestId: z.string(),
});

export const AgentInstallListResponseSchema = z.object({
  type: z.literal("agent.install.list.response"),
  payload: z
    .object({
      requestId: z.string(),
      entries: z.array(AgentInstallEntrySchema),
    })
    .passthrough(),
});

export const AgentInstallRunRequestSchema = z.object({
  type: z.literal("agent.install.run.request"),
  requestId: z.string(),
  provider: z.string().min(1),
  commandId: z.string().min(1),
  /** How long the daemon may keep the command running. */
  timeoutMs: z.number().int().positive().optional(),
});

export const AgentInstallRunResponseSchema = z.object({
  type: z.literal("agent.install.run.response"),
  payload: z
    .object({
      requestId: z.string(),
      provider: z.string().min(1),
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      /** stdout and stderr, in arrival order, capped by the daemon. */
      output: z.string(),
      error: z.string().nullable(),
    })
    .passthrough(),
});

export type AgentInstallCommand = z.infer<typeof AgentInstallCommandSchema>;
export type AgentInstallEntry = z.infer<typeof AgentInstallEntrySchema>;
export type AgentInstallRunResult = z.infer<typeof AgentInstallRunResponseSchema>["payload"];

/**
 * Undoes an install with the vendor's documented uninstall line. Optional
 * because it arrived after `agent.install.run`; a daemon that answers the
 * request runs one of its fixed lines, never one the client sends.
 */
export const AgentInstallUninstallRequestSchema = z.object({
  type: z.literal("agent.install.uninstall.request"),
  requestId: z.string(),
  provider: z.string().min(1),
  /** Which uninstall line, when the vendor documents more than one. */
  commandId: z.string().min(1).optional(),
  /** How long the daemon may keep the command running. */
  timeoutMs: z.number().int().positive().optional(),
});

export const AgentInstallUninstallResponseSchema = z.object({
  type: z.literal("agent.install.uninstall.response"),
  payload: z
    .object({
      requestId: z.string(),
      provider: z.string().min(1),
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      /** stdout and stderr, in arrival order, capped by the daemon. */
      output: z.string(),
      error: z.string().nullable(),
    })
    .passthrough(),
});

export type AgentInstallUninstallResult = z.infer<
  typeof AgentInstallUninstallResponseSchema
>["payload"];
