import type {
  AggregateLoadState,
  AggregatedSchedule,
  ScheduleHostError,
} from "@/schedules/aggregated-schedules";

export type SchedulesScreenBodyState =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

export function resolveSchedulesScreenBodyState(input: {
  loadState: AggregateLoadState<AggregatedSchedule>;
  showLoadError: boolean;
}): SchedulesScreenBodyState {
  if (input.showLoadError) {
    return { kind: "load-error" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  if (input.loadState.status === "offline") {
    return { kind: "offline" };
  }
  if (input.loadState.data.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}

/** Partial host failures only make sense once the aggregate answered. */
export function shouldRenderScheduleHostErrors(input: {
  bodyState: SchedulesScreenBodyState;
  hostErrors: readonly ScheduleHostError[];
}): boolean {
  return (
    (input.bodyState.kind === "empty" || input.bodyState.kind === "content") &&
    input.hostErrors.length > 0
  );
}
