// FILE: aboutSettings.logic.ts
// Purpose: Derive the Settings › About gateway rows (public address and the
//          Claude Code status-line command for another computer) from the
//          daemon's listen address and NEOLIX_PUBLIC_URL.
// Layer: Settings logic

import { gatewayOrigin, parseListen } from "./gateway/gatewayHelpers";

export interface AboutGatewayRows {
  /** The address this computer reaches the gateway at, when it has one. */
  readonly gatewayOrigin: string | null;
  /** NEOLIX_PUBLIC_URL with any trailing slash removed; null when unset. */
  readonly publicUrl: string | null;
  /** myna hides the row when the public address is the local one. */
  readonly showPublicAddress: boolean;
  /** The command another computer puts in Claude Code's statusLine. */
  readonly statuslineCommand: string | null;
}

function trimmedBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/u, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function statuslineCommandFor(remoteUrl: string): string {
  return `curl -fsS -m 1 -H 'Authorization: Bearer <gateway key>' --data-binary @- ${remoteUrl}/v1/myna/statusline || true`;
}

export function aboutGatewayRows(
  listen: string | null | undefined,
  publicUrl: string | null | undefined,
): AboutGatewayRows {
  const gatewayAddress = gatewayOrigin(parseListen(listen));
  const remote = trimmedBaseUrl(publicUrl);
  return {
    gatewayOrigin: gatewayAddress,
    publicUrl: remote,
    showPublicAddress: remote !== null && remote !== gatewayAddress,
    statuslineCommand: remote === null ? null : statuslineCommandFor(remote),
  };
}
