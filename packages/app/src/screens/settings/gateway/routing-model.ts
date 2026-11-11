import type {
  GatewayRoutePromptWire,
  GatewayRouteSeatWire,
  GatewayRouteTraceWire,
  GatewayRouteTryWire,
  GatewayRouteWire,
} from "@neolix/protocol/gateway";
import type { TFunction } from "i18next";
import { agentDisplayName } from "./routing-agent-names";

export type RoutingTone = "neutral" | "active" | "ok" | "danger" | "muted";

export interface RoutingStep {
  key: string;
  text: string;
  tone: RoutingTone;
}

export interface PromptSegment {
  kind: GatewayRoutePromptWire["parts"][number]["kind"] | "remaining";
  tokens: number;
  ratio: number;
}

export function latestRoute(trace: GatewayRouteTraceWire | null): GatewayRouteWire | null {
  return trace?.routes[0] ?? null;
}

export function isRouteLive(route: GatewayRouteWire): boolean {
  return !route.done;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  }
  return String(value);
}

export function formatDuration(millis: number | null): string {
  if (millis === null) {
    return "";
  }
  if (millis < 1000) {
    return `${Math.round(millis)}ms`;
  }
  return `${(millis / 1000).toFixed(1)}s`;
}

export function formatClock(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function seatName(seat: GatewayRouteSeatWire): string {
  return seat.account === null
    ? seat.providerLabel
    : `${seat.providerLabel} · ${seat.accountLabel}`;
}

export function routeServedModel(route: GatewayRouteWire): string {
  const answered = route.tries.find(
    (entry) => entry.done && entry.status !== null && entry.status < 400,
  );
  return answered?.model ?? route.seats[0]?.model ?? route.routedModel;
}

/** What a seat is doing for the request being shown. */
export function seatStatus(
  seat: GatewayRouteSeatWire,
  route: GatewayRouteWire,
  now: number,
  t: TFunction,
): { text: string; tone: RoutingTone; active: boolean } {
  const working = route.tries.find(
    (entry) =>
      !entry.done && entry.provider === seat.provider && (entry.account ?? null) === seat.account,
  );
  if (working !== undefined) {
    return { text: t("settings.gatewayPages.routing.seatAnswering"), tone: "active", active: true };
  }
  const answered = route.tries.find(
    (entry) =>
      entry.done &&
      entry.provider === seat.provider &&
      (entry.account ?? null) === seat.account &&
      entry.status !== null &&
      entry.status < 400,
  );
  if (answered !== undefined) {
    return { text: t("settings.gatewayPages.routing.seatAnswered"), tone: "ok", active: true };
  }
  const failed = route.tries.find(
    (entry) =>
      entry.done && entry.provider === seat.provider && (entry.account ?? null) === seat.account,
  );
  if (failed !== undefined) {
    return {
      text: t("settings.gatewayPages.routing.seatFailed", {
        status: failed.status ?? "—",
        ms: formatDuration(failed.millis),
      }),
      tone: "danger",
      active: false,
    };
  }
  if (seat.restingUntil !== null && seat.restingUntil > now) {
    const seconds = Math.max(1, Math.round((seat.restingUntil - now) / 1000));
    return {
      text: t("settings.gatewayPages.routing.seatResting", { when: `${seconds}s` }),
      tone: "muted",
      active: false,
    };
  }
  return {
    text: t("settings.gatewayPages.routing.seatWaiting", { n: seat.rank + 1 }),
    tone: "neutral",
    active: false,
  };
}

export function buildSteps(route: GatewayRouteWire, t: TFunction): RoutingStep[] {
  const steps: RoutingStep[] = [];
  const served = routeServedModel(route);
  const provider = route.providerLabel ?? route.provider ?? route.routedModel;
  const servedText =
    served === route.model
      ? t("settings.gatewayPages.routing.stepAsked", {
          agent: agentDisplayName(route.agent),
          model: route.model,
          provider,
        })
      : t("settings.gatewayPages.routing.stepAskedServed", {
          agent: agentDisplayName(route.agent),
          model: route.model,
          provider,
          served,
        });
  steps.push({ key: "asked", text: servedText, tone: "neutral" });
  if (route.group !== null) {
    steps.push({
      key: "group",
      text: t("settings.gatewayPages.routing.stepGroup", {
        group: route.group,
        strategy: route.strategy,
      }),
      tone: "neutral",
    });
  }
  if (route.alias !== null) {
    steps.push({
      key: "alias",
      text: t("settings.gatewayPages.routing.stepAlias", {
        from: route.model,
        to: route.alias,
      }),
      tone: "neutral",
    });
  }
  if (route.masked) {
    steps.push({
      key: "masked",
      text: t("settings.gatewayPages.routing.stepMasked"),
      tone: "neutral",
    });
  }
  if (route.seats.length > 1) {
    steps.push({
      key: "order",
      text: t("settings.gatewayPages.routing.stepOrder", {
        seats: route.seats.map(seatName).join(" → "),
      }),
      tone: "neutral",
    });
  } else if (route.seats.length === 1) {
    steps.push({
      key: "order",
      text: t("settings.gatewayPages.routing.stepOnlySeat", { seat: seatName(route.seats[0]!) }),
      tone: "neutral",
    });
  }
  for (const [index, entry] of route.tries.entries()) {
    steps.push({
      key: `try-${index}`,
      text: tryText(entry, index, route, t),
      tone: tryTone(entry, route),
    });
  }
  if (route.done) {
    steps.push({
      key: "done",
      text: doneText(route, t),
      tone: route.error === null ? "ok" : "danger",
    });
  }
  return steps;
}

function tryText(
  entry: GatewayRouteTryWire,
  index: number,
  route: GatewayRouteWire,
  t: TFunction,
): string {
  const seat = `${entry.provider}/${entry.model}`;
  if (!entry.done) {
    return t("settings.gatewayPages.routing.stepTryRunning", { seat });
  }
  const last = index === route.tries.length - 1;
  if (entry.status !== null && entry.status < 400) {
    return t("settings.gatewayPages.routing.stepTryAnswered", {
      seat,
      status: entry.status,
      ms: formatDuration(entry.millis),
    });
  }
  // A failure that may pass: waited out, or the whole group asked again
  // (myna's Try.Again, Replan and Patience).
  if (entry.again !== undefined) {
    const said = {
      who: seat,
      status: entry.status ?? "—",
      fail: entry.error ?? "—",
      d: formatDuration(entry.again),
      agent: route.agent,
    };
    if (entry.replan === undefined) {
      return t("settings.gatewayPages.routing.stepTryAgain", said);
    }
    return t("settings.gatewayPages.routing.stepTryReplan", {
      ...said,
      n: entry.replan,
      p: formatDuration((entry.patience ?? 0) * 1000),
    });
  }
  return t(
    last
      ? "settings.gatewayPages.routing.stepTryFailed"
      : "settings.gatewayPages.routing.stepTryRerouted",
    {
      seat,
      status: entry.status ?? "—",
    },
  );
}

function tryTone(entry: GatewayRouteTryWire, route: GatewayRouteWire): RoutingTone {
  if (!entry.done) {
    return "active";
  }
  if (entry.status !== null && entry.status < 400) {
    return "ok";
  }
  return route.error !== null && route.tries.at(-1) === entry ? "danger" : "muted";
}

function doneText(route: GatewayRouteWire, t: TFunction): string {
  if (route.error !== null) {
    return t("settings.gatewayPages.routing.stepFailed", {
      status: route.status ?? "—",
      error: route.error,
    });
  }
  return t("settings.gatewayPages.routing.stepDone", {
    status: route.status ?? "—",
    ms: formatDuration(route.millis),
  });
}

export function promptSegments(prompt: GatewayRoutePromptWire): PromptSegment[] {
  const window = prompt.window;
  if (window === null || window <= prompt.tokens) {
    return prompt.parts.map((part) => ({
      kind: part.kind,
      tokens: part.tokens,
      ratio: prompt.tokens === 0 ? 0 : part.tokens / prompt.tokens,
    }));
  }
  const segments: PromptSegment[] = prompt.parts.map((part) => ({
    kind: part.kind,
    tokens: part.tokens,
    ratio: part.tokens / window,
  }));
  segments.push({
    kind: "remaining",
    tokens: window - prompt.tokens,
    ratio: (window - prompt.tokens) / window,
  });
  return segments;
}

export function healthOf(used: number, window: number | null): "healthy" | "tight" | "over" {
  if (window === null || window <= 0) {
    return "healthy";
  }
  const ratio = used / window;
  if (ratio >= 1) {
    return "over";
  }
  return ratio >= 0.85 ? "tight" : "healthy";
}

export function averagePromptTokens(trace: GatewayRouteTraceWire): number | null {
  const sizes = trace.routes
    .map((route) => route.prompt?.tokens ?? 0)
    .filter((tokens) => tokens > 0);
  if (sizes.length === 0) {
    return null;
  }
  const total = sizes.reduce((sum, tokens) => sum + tokens, 0);
  return Math.round(total / sizes.length);
}
