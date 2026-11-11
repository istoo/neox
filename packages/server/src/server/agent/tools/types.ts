import type { z } from "zod";
import type { ProviderNeolixToolsPolicy } from "@neolix/protocol/provider-config";

export class NeolixToolInputError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly issues?: z.ZodError["issues"],
  ) {
    super(message);
    this.name = "NeolixToolInputError";
  }
}

export interface NeolixToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: NeolixToolResult) => void;
}

export interface NeolixToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface NeolixToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface NeolixToolDefinition extends NeolixToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: NeolixToolExecutionContext) => Promise<NeolixToolResult>;
}

export interface NeolixToolCatalog {
  tools: ReadonlyMap<string, NeolixToolDefinition>;
  getTool(name: string): NeolixToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: NeolixToolExecutionContext,
  ): Promise<NeolixToolResult>;
}

export interface NeolixToolRuntimeContext {
  callerAgentId?: string;
  neolixToolPolicy?: ProviderNeolixToolsPolicy;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type NeolixToolCatalogFactory = (
  context: NeolixToolRuntimeContext,
) => NeolixToolCatalog | Promise<NeolixToolCatalog>;
