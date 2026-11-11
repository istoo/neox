import { useCallback, useMemo } from "react";
import {
  BUILTIN_FEATURE_IDS,
  BUILTIN_FEATURE_SURFACES,
  DEFAULT_GATEWAY_CALLS_PAGE,
  hiddenBuiltinSurfaces,
  type BuiltinFeatureId,
  type BuiltinFeatures,
} from "@neolix/protocol/plugin-features";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useSettingsHostServerId } from "@/screens/settings/app/shared";
import { builtinFeatureUseCounts } from "./builtin-feature-usage";

interface BuiltinFeatureState {
  features: BuiltinFeatures | undefined;
  /** The surfaces the switches turn off, after in-use features are kept on. */
  hidden: ReturnType<typeof hiddenBuiltinSurfaces>;
  /** How much of the feature is in use; myna keeps those switches on. */
  useCount(id: BuiltinFeatureId): number;
  useCounts: Record<BuiltinFeatureId, number>;
  isEnabled(id: BuiltinFeatureId): boolean;
  setEnabled(id: BuiltinFeatureId, enabled: boolean): void;
  /** myna's gateway schema field: how many recent calls the page shows before "Show more". */
  gatewayCallsPage: number;
  setGatewayCallsPage(value: number): void;
}

/**
 * myna's Plugins › Built-in switches for a host, from its daemon config. A feature without a
 * stored switch is on, so an install starts with everything shown. A feature with something in
 * use stays on, as myna's InUse plugins do.
 */
export function useBuiltinFeatures(serverId: string | null): BuiltinFeatureState {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { config: gateway } = useGatewayConfig(serverId);
  const features = config?.builtinFeatures;
  const uses = useMemo(() => builtinFeatureUseCounts(gateway), [gateway]);
  const effectiveFeatures = useMemo(() => {
    const effective: BuiltinFeatures = {};
    for (const id of BUILTIN_FEATURE_IDS) {
      effective[id] = features?.[id] !== false || uses[id] > 0;
    }
    return effective;
  }, [features, uses]);
  const hidden = useMemo(() => hiddenBuiltinSurfaces(effectiveFeatures), [effectiveFeatures]);
  const useCount = useCallback((id: BuiltinFeatureId) => uses[id], [uses]);
  const isEnabled = useCallback(
    (id: BuiltinFeatureId) => uses[id] > 0 || features?.[id] !== false,
    [features, uses],
  );
  const setEnabled = useCallback(
    (id: BuiltinFeatureId, enabled: boolean) => {
      // In use: myna refuses to turn it off, so the switch stays where it is.
      if (!enabled && uses[id] > 0) return;
      // Merge over the host's current switches so one toggle never erases another.
      void patchConfig({ builtinFeatures: { ...features, [id]: enabled } });
    },
    [features, patchConfig, uses],
  );
  const gatewayCallsPage =
    config?.builtinFeatureConfig?.gateway?.callsPage ?? DEFAULT_GATEWAY_CALLS_PAGE;
  const setGatewayCallsPage = useCallback(
    (value: number) => {
      // Beside the switches, merged the same way so one setting never erases another.
      void patchConfig({
        builtinFeatureConfig: {
          ...config?.builtinFeatureConfig,
          gateway: { ...config?.builtinFeatureConfig?.gateway, callsPage: value },
        },
      });
    },
    [config?.builtinFeatureConfig, patchConfig],
  );
  return {
    features,
    hidden,
    useCount,
    useCounts: uses,
    isEnabled,
    setEnabled,
    gatewayCallsPage,
    setGatewayCallsPage,
  };
}

/** The same switches for whichever host the app is looking at. */
export function useActiveHostBuiltinFeatures(): BuiltinFeatureState {
  const serverId = useSettingsHostServerId();
  return useBuiltinFeatures(serverId);
}

/** One feature's effective switch for a host; a block that hides with it asks this. */
export function useBuiltinFeatureEnabled(serverId: string | null, id: BuiltinFeatureId): boolean {
  const { isEnabled } = useBuiltinFeatures(serverId);
  return isEnabled(id);
}

interface BuiltinFeatureCopy {
  name: string;
  zhName: string;
  description: string;
  zhDescription: string;
}

/** myna's own names and subtitles for each switch. */
export const BUILTIN_FEATURE_COPY: Record<BuiltinFeatureId, BuiltinFeatureCopy> = {
  sessions: {
    name: "Sessions",
    zhName: "会话",
    description: "Your agents' past conversations: read, search, resume and export them.",
    zhDescription: "代理的历史对话：阅读、搜索、恢复与导出。",
  },
  library: {
    name: "Library",
    zhName: "资源库",
    description: "Instructions, MCP servers, skills and hooks, kept once and given to every agent.",
    zhDescription: "指令、MCP 服务器、技能与钩子，集中维护并交给每个代理。",
  },
  routing: {
    name: "Routing",
    zhName: "路由",
    description:
      "Each request as the gateway routes it, the accounts it weighed and what each answered.",
    zhDescription: "按网关的路由查看每个请求、权衡过的账号及各自的回答。",
  },
  usage: {
    name: "Usage",
    zhName: "用量",
    description: "Your allowances, what was spent and on what, and what filled the context window.",
    zhDescription: "额度、花费去向，以及上下文窗口的占用。",
  },
  gateway: {
    name: "Gateway page",
    zhName: "网关页",
    description: "The gateway's state and keys, how to connect a client, its models and calls.",
    zhDescription: "网关状态与密钥、客户端接入方式、模型与最近调用。",
  },
  redact: {
    name: "Privacy masking",
    zhName: "隐私遮蔽",
    description:
      "Secrets and personal data go to vendors as placeholders and come back as they were.",
    zhDescription: "密钥与个人数据以占位符发给厂商，返回时还原。",
  },
  otel: {
    name: "Observability",
    zhName: "可观测性",
    description: "Send each request's traces and metrics to an OpenTelemetry collector.",
    zhDescription: "把每个请求的追踪与指标发送到 OpenTelemetry 收集器。",
  },
  warmups: {
    name: "Warm-up and check-in",
    zhName: "预热与签到",
    description: "Start a subscription's usage window at a chosen time and claim daily credits.",
    zhDescription: "在指定时间开启订阅的使用窗口，并领取每日签到额度。",
  },
  groups: {
    name: "Routing groups",
    zhName: "路由组",
    description: "Several models agents pick as one, with failover to the next.",
    zhDescription: "多个模型作为一个供代理选择，失败时切到下一个。",
  },
  rotation: {
    name: "Routing strategies",
    zhName: "路由策略",
    description: "The routings besides Smart: in order, in turn, by weight and the rest.",
    zhDescription: "Smart 之外的路由方式：顺序、轮转、按权重等。",
  },
  middleware: {
    name: "JS gateway plugins",
    zhName: "JS 网关插件",
    description:
      "JavaScript middleware on agents' requests and replies, routings, usage observers.",
    zhDescription: "作用于代理请求与回复的 JavaScript 中间件、路由与用量观察器。",
  },
  budget: {
    name: "Key limits",
    zhName: "密钥限额",
    description: "Hold each gateway key to the tokens or estimated cost you set for it.",
    zhDescription: "让每把网关密钥遵守设定的 token 或费用上限。",
  },
  tools: {
    name: "Plugin tools",
    zhName: "插件工具",
    description: "Offer the tools your plugins give to every agent, as an MCP server.",
    zhDescription: "把插件提供的工具作为 MCP 服务器交给每个代理。",
  },
  search: {
    name: "Web search",
    zhName: "网页搜索",
    description: "Models that cannot search use a provider that can, or a search API.",
    zhDescription: "无法联网搜索的模型改用支持搜索的模型来源或搜索 API。",
  },
};

/** Features whose Neolix surface is a block inside a page rather than a whole page. */
const BLOCK_SURFACES: ReadonlySet<BuiltinFeatureId> = new Set([
  "warmups",
  "groups",
  "rotation",
  "middleware",
  "budget",
  "tools",
  "search",
]);

/** Whether Neolix currently draws anything for a feature. */
export function builtinFeatureHasSurface(id: BuiltinFeatureId): boolean {
  if (BLOCK_SURFACES.has(id)) return true;
  const surfaces = BUILTIN_FEATURE_SURFACES[id];
  return (
    surfaces.hostSections.length > 0 ||
    surfaces.settingsPages.length > 0 ||
    surfaces.sidebarItems.length > 0
  );
}

export function builtinFeatureText(
  id: BuiltinFeatureId,
  language: string,
): { name: string; description: string } {
  const copy = BUILTIN_FEATURE_COPY[id];
  return language.toLowerCase().startsWith("zh")
    ? { name: copy.zhName, description: copy.zhDescription }
    : { name: copy.name, description: copy.description };
}
