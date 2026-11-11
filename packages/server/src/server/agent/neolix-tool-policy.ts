import type { ProviderNeolixToolsPolicy } from "@neolix/protocol/provider-config";

interface ProviderNeolixToolSettings {
  neolixTools?: ProviderNeolixToolsPolicy;
}

export function resolveNeolixToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderNeolixToolSettings>> | undefined,
): ProviderNeolixToolsPolicy | undefined {
  return providerSettings?.[providerId]?.neolixTools;
}

export function isNeolixToolEnabled(
  policy: ProviderNeolixToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isNeolixToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isNeolixToolPolicyEnabled(policy: ProviderNeolixToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}
