import { z } from "zod";
import type { ProviderNeolixToolsPolicy } from "@neolix/protocol/provider-config";
import type { AgentManager } from "../agent-manager.js";
import { isNeolixToolEnabled } from "../neolix-tool-policy.js";
import type { NeolixToolDefinition } from "./types.js";
import { addModelVisibleStructuredContent } from "./neolix-tool-serialization.js";

export function registerPluginTools(options: {
  agentManager: AgentManager;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  tools: Map<string, NeolixToolDefinition>;
  builtinNames: Set<string>;
  policy?: ProviderNeolixToolsPolicy;
}): void {
  const { agentManager, callerAgentId, scope, tools, builtinNames, policy } = options;
  if (scope !== "agent" || !callerAgentId) return;
  for (const tool of agentManager.getPluginTools(callerAgentId)) {
    if (builtinNames.has(tool.name)) {
      throw new Error(
        `Agent tool ${tool.name} from plugin ${tool.pluginId} collides with Neox tool ${tool.name}`,
      );
    }
    if (!isNeolixToolEnabled(policy, tool.name)) continue;
    tools.set(tool.name, {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.fromJSONSchema(tool.inputSchema),
      async handler(input, { signal }) {
        const result = await agentManager.executePluginTool(tool, callerAgentId, input, signal);
        return addModelVisibleStructuredContent({
          content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
          isError: result.isError,
        });
      },
    });
  }
}
