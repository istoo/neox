import type { ProbeNotice } from "./provider-probe.js";
import type { UsageLedger } from "./usage.js";

/**
 * Writes the settings page's own provider calls into the request log, as
 * myna's probelog does: each row names the host the form is editing and the
 * call's kind, and the ledger leaves it out of every usage and cost total.
 */
export function probeRecorder(ledger: UsageLedger): (notice: ProbeNotice) => void {
  return (notice) => {
    ledger.record({
      time: new Date(Date.now() - notice.millis).toISOString(),
      requested: notice.model ?? "",
      provider: hostOf(notice.baseUrl),
      account: null,
      model: notice.model ?? "",
      protocol: notice.protocol,
      status: notice.status,
      ok: notice.status >= 200 && notice.status < 300,
      inputTokens: 0,
      outputTokens: 0,
      attempts: 1,
      durationMs: notice.millis,
      costUsd: 0,
      priced: false,
      key: null,
      probe: notice.kind,
    });
  };
}

/** The host a probe went to; the form's URL may be half typed. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.trim();
  }
}
