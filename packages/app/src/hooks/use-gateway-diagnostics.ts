import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  GatewayArchiveRecordWire,
  GatewayHistoryRouteWire,
  GatewayPromptTextWire,
  GatewayReplyWire,
  GatewayTuneAdviceWire,
} from "@neolix/protocol/gateway";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/**
 * The request views behind the Routing page's history: a day's routes, one
 * archived call, and the prompt text still in memory. The daemon keeps these;
 * the page asks over session RPCs, never the gateway's HTTP endpoints.
 */

export function gatewayRoutingHistoryQueryKey(serverId: string, day: string) {
  return ["gateway-routing-history", serverId, day] as const;
}

export function gatewayArchiveQueryKey(serverId: string, date: string | null, id: string | null) {
  return ["gateway-archive", serverId, date, id] as const;
}

export function gatewayPromptTextQueryKey(serverId: string, id: string | null) {
  return ["gateway-prompt-text", serverId, id] as const;
}

export function gatewayHeldReportsQueryKey(serverId: string) {
  return ["gateway-held-reports", serverId] as const;
}

export function gatewayHeldReportQueryKey(serverId: string, name: string | null) {
  return ["gateway-held-report", serverId, name] as const;
}

export function useGatewayDiagnosticsSupported(serverId: string): boolean {
  return useHostFeature(serverId, "gatewayDiagnostics");
}

export function useGatewayRoutingHistory(
  serverId: string,
  day: string,
): {
  days: string[];
  routes: GatewayHistoryRouteWire[];
  isLoading: boolean;
  error: Error | null;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useGatewayDiagnosticsSupported(serverId);
  const queryKey = useMemo(() => gatewayRoutingHistoryQueryKey(serverId, day), [serverId, day]);

  const query = useFetchQuery<{ days: string[]; routes: GatewayHistoryRouteWire[] }>({
    queryKey,
    enabled: supported && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.getGatewayRoutingHistory(day.length === 0 ? undefined : day);
      return { days: payload.days, routes: payload.routes };
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    days: query.data?.days ?? [],
    routes: query.data?.routes ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** One call from the request archive; asks only when a call names one. */
export function useGatewayArchivedCall(
  serverId: string,
  reference: string | null,
): {
  call: GatewayArchiveRecordWire | null;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useGatewayDiagnosticsSupported(serverId);
  const split = useMemo(() => splitArchiveName(reference), [reference]);
  const queryKey = useMemo(
    () => gatewayArchiveQueryKey(serverId, split.date, split.id),
    [serverId, split.date, split.id],
  );

  const query = useFetchQuery<GatewayArchiveRecordWire | null>({
    queryKey,
    enabled:
      supported && split.date !== null && split.id !== null && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client || split.date === null || split.id === null) {
        return null;
      }
      const payload = await client.getGatewayArchivedCall(split.date, split.id);
      return payload.archive;
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    call: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** The masked request body still kept for a call's prompt. */
export function useGatewayPromptText(
  serverId: string,
  id: string | null,
): {
  text: GatewayPromptTextWire | null;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useGatewayDiagnosticsSupported(serverId);
  const queryKey = useMemo(() => gatewayPromptTextQueryKey(serverId, id), [serverId, id]);

  const query = useFetchQuery<GatewayPromptTextWire | null>({
    queryKey,
    enabled: supported && id !== null && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client || id === null) {
        return null;
      }
      const payload = await client.getGatewayPromptText(id);
      return payload.text;
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    text: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** The reply an archived call got, piece by piece (myna's prompt_reply). */
export function useGatewayPromptReply(
  serverId: string,
  reference: string | null,
): {
  reply: GatewayReplyWire | null;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useGatewayDiagnosticsSupported(serverId);
  const split = useMemo(() => splitArchiveName(reference), [reference]);
  const queryKey = useMemo(
    () => gatewayReplyQueryKey(serverId, split.date, split.id),
    [serverId, split.date, split.id],
  );

  const query = useFetchQuery<GatewayReplyWire | null>({
    queryKey,
    enabled:
      supported && split.date !== null && split.id !== null && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client || split.date === null || split.id === null) {
        return null;
      }
      const payload = await client.getGatewayPromptReply(split.date, split.id);
      return payload.reply;
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    reply: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function gatewayReplyQueryKey(serverId: string, date: string | null, id: string | null) {
  return ["gateway-reply", serverId, date, id] as const;
}

/** The held-request reports the daemon kept, newest first. */
export function useGatewayHeldReports(serverId: string): {
  names: string[];
  isLoading: boolean;
  error: Error | null;
} {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useGatewayDiagnosticsSupported(serverId);
  const queryKey = useMemo(() => gatewayHeldReportsQueryKey(serverId), [serverId]);

  const query = useFetchQuery<string[]>({
    queryKey,
    enabled: supported && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 10_000,
    queryFn: async () => {
      if (!client) {
        return [];
      }
      const payload = await client.getGatewayHeldReports();
      return payload.names;
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    names: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** One held-request report's text, or null once it is gone. */
export function useGatewayHeldReport(
  serverId: string,
  name: string | null,
): {
  text: string | null;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useGatewayDiagnosticsSupported(serverId);
  const queryKey = useMemo(() => gatewayHeldReportQueryKey(serverId, name), [serverId, name]);

  const query = useFetchQuery<string | null>({
    queryKey,
    enabled: supported && name !== null && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client || name === null) {
        return null;
      }
      const payload = await client.getGatewayHeldReport(name);
      return payload.text;
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    text: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** `<date>/<id>`, as the routing history and the archive header write it. */
export function splitArchiveName(reference: string | null): {
  date: string | null;
  id: string | null;
} {
  if (reference === null) {
    return { date: null, id: null };
  }
  const [date, id] = reference.split("/");
  if (date === undefined || id === undefined || date.length === 0 || id.length === 0) {
    return { date: null, id: null };
  }
  return { date, id };
}

/** The settings tune would change, replayed from the user's own calls. */
export function useGatewayTune(
  serverId: string,
  days = 7,
): {
  advice: GatewayTuneAdviceWire[];
  days: number;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "gatewayTune");
  const queryKey = useMemo(() => gatewayTuneQueryKey(serverId, days), [serverId, days]);

  const query = useFetchQuery<{ advice: GatewayTuneAdviceWire[]; days: number }>({
    queryKey,
    enabled: supported && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 60_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.getGatewayTune(days);
      return { advice: payload.advice, days: payload.days };
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    advice: query.data?.advice ?? [],
    days: query.data?.days ?? days,
    isLoading: query.isLoading,
    error: query.error,
    refresh: query.refetch,
  };
}

export function gatewayTuneQueryKey(serverId: string, days: number) {
  return ["gateway-tune", serverId, days] as const;
}
