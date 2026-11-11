import type { GatewayProviderWire } from "./gateway.js";

/**
 * The vendors the add sheet and `neolix presets` offer, ported from myna's
 * presets (internal/provider/presets.go). Shared data: the app draws them and
 * the CLI reads them, so it lives in the package both depend on.
 * Each endpoint is a base URL for one protocol; a vendor that serves several gives one per
 * protocol, so switching the protocol in the editor switches the URL with it.
 */
export type GatewayProviderPresetKind = "vendor" | "relay" | "local";

export interface GatewayProviderPreset {
  id: string;
  name: string;
  /** The vendor's full name when the row shows a shorter one. */
  fullName?: string;
  kind: GatewayProviderPresetKind;
  /** Base URLs by protocol. */
  endpoints: Partial<Record<GatewayProviderWire["protocol"], string>>;
  website?: string;
  keysUrl?: string;
  note?: string;
  /** Google Vertex AI: no key, but a project, location and credentials. */
  vertex?: boolean;
  /**
   * The models the preset starts with, when its vendor has no list to ask
   * (myna's `preset.Models`). A preset without them starts with none and
   * fills them from the vendor's own list.
   */
  models?: readonly string[];
  /**
   * The catalog its list prices come from (myna's `preset.Catalog`), when it
   * is not the vendor's own.
   */
  catalog?: string;
  /**
   * A decision API's root (myna's `preset.Decide`, TypeSafe's System One):
   * the provider routes routing groups, and its models are never an agent's.
   * `{WorkspaceId}` stands for a Bailian workspace the user fills in.
   */
  decide?: string;
  /**
   * The word the editor puts on the region picker (myna's `RegionLabel`):
   * "Plan" for a subscription's plans.
   */
  regionLabel?: string;
  /** The plans or regions the preset is sold in (myna's `preset.Regions`). */
  regions?: readonly GatewayProviderPresetRegion[];
}

/** One plan or region of a preset, with the endpoints that serve it. */
export interface GatewayProviderPresetRegion {
  id: string;
  name: string;
  endpoints: Partial<Record<GatewayProviderWire["protocol"], string>>;
  website?: string;
  keysUrl?: string;
  catalog?: string;
  /** The decision API this plan or region answers on, when it has one. */
  decide?: string;
}

export const GATEWAY_PROVIDER_PRESETS: readonly GatewayProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "vendor",
    endpoints: { anthropic: "https://api.anthropic.com" },
    website: "https://console.anthropic.com",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "vendor",
    endpoints: {
      openai: "https://api.openai.com/v1",
      "openai-responses": "https://api.openai.com/v1",
    },
    website: "https://platform.openai.com",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    name: "Google Gemini",
    kind: "vendor",
    endpoints: { openai: "https://generativelanguage.googleapis.com/v1beta/openai" },
    website: "https://aistudio.google.com",
    keysUrl: "https://aistudio.google.com/apikey",
    note: "Gemini Developer API",
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    kind: "vendor",
    // The project's address, not a vendor's: requests go to its location's
    // host (vertex-auth.ts). The provider schema requires a baseUrl, so this
    // stands in for it; the gateway's request path never uses it.
    endpoints: { gemini: "https://aiplatform.googleapis.com" },
    website: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models",
    note: "your Google Cloud project, with gcloud's sign-in",
    vertex: true,
    // myna's Vertex preset has no list to ask, so it gives these: every one
    // global serves (`provider/presets.go:192-196`).
    models: [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-4-argon",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "deepseek-ai/deepseek-v4.1-flash-maas",
      "zai-org/glm-5.2-maas",
      "openai/gpt-oss-120b-maas",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "vendor",
    endpoints: {
      openai: "https://api.deepseek.com/v1",
      "openai-responses": "https://api.deepseek.com/v1",
      anthropic: "https://api.deepseek.com/anthropic",
    },
    website: "https://platform.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "xai",
    name: "xAI",
    kind: "vendor",
    endpoints: {
      openai: "https://api.x.ai/v1",
      "openai-responses": "https://api.x.ai/v1",
      anthropic: "https://api.x.ai",
    },
    website: "https://console.x.ai",
    keysUrl: "https://console.x.ai",
  },
  {
    id: "moonshot",
    name: "Kimi",
    kind: "vendor",
    endpoints: {
      openai: "https://api.moonshot.ai/v1",
      anthropic: "https://api.moonshot.ai/anthropic",
    },
    website: "https://platform.kimi.ai?aff=myna",
    keysUrl: "https://platform.kimi.ai/console/api-keys?aff=myna",
  },
  {
    id: "moonshot-cn",
    name: "Kimi (China)",
    kind: "vendor",
    endpoints: {
      openai: "https://api.moonshot.cn/v1",
      anthropic: "https://api.moonshot.cn/anthropic",
    },
    website: "https://platform.kimi.com?aff=myna",
    keysUrl: "https://platform.kimi.com/console/api-keys?aff=myna",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    kind: "vendor",
    endpoints: { openai: "https://api.kimi.ai/coding/v1", anthropic: "https://api.kimi.ai/coding" },
    website: "https://www.kimi.ai/code?aff=myna",
    keysUrl: "https://www.kimi.ai/code/console?aff=myna",
    note: "Membership",
  },
  {
    id: "kimi-code-cn",
    name: "Kimi Code (China)",
    kind: "vendor",
    endpoints: {
      openai: "https://api.kimi.com/coding/v1",
      anthropic: "https://api.kimi.com/coding",
    },
    website: "https://www.kimi.com/code?aff=myna",
    keysUrl: "https://www.kimi.com/code/console?aff=myna",
    note: "Membership",
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    kind: "vendor",
    endpoints: {
      openai: "https://open.bigmodel.cn/api/paas/v4",
      "openai-responses": "https://open.bigmodel.cn/api/v1",
      anthropic: "https://open.bigmodel.cn/api/anthropic",
    },
    website: "https://open.bigmodel.cn",
    keysUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    regionLabel: "Plan",
    regions: [
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://open.bigmodel.cn/api/paas/v4",
          anthropic: "https://open.bigmodel.cn/api/anthropic",
        },
      },
      {
        id: "coding",
        name: "Coding Plan",
        endpoints: {
          openai: "https://open.bigmodel.cn/api/coding/paas/v4",
          "openai-responses": "https://open.bigmodel.cn/api/v1",
          anthropic: "https://open.bigmodel.cn/api/anthropic",
        },
      },
    ],
  },
  {
    id: "zai",
    name: "Z.ai",
    kind: "vendor",
    endpoints: {
      openai: "https://api.z.ai/api/paas/v4",
      "openai-responses": "https://api.z.ai/api/v1",
      anthropic: "https://api.z.ai/api/anthropic",
    },
    website: "https://z.ai",
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    regionLabel: "Plan",
    regions: [
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://api.z.ai/api/paas/v4",
          anthropic: "https://api.z.ai/api/anthropic",
        },
      },
      {
        id: "coding",
        name: "Coding Plan",
        endpoints: {
          openai: "https://api.z.ai/api/coding/paas/v4",
          "openai-responses": "https://api.z.ai/api/v1",
          anthropic: "https://api.z.ai/api/anthropic",
        },
      },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    kind: "vendor",
    endpoints: {
      openai: "https://api.minimax.io/v1",
      anthropic: "https://api.minimax.io/anthropic",
    },
    website: "https://platform.minimax.io",
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "minimax-cn",
    name: "MiniMax (China)",
    kind: "vendor",
    endpoints: {
      openai: "https://api.minimaxi.com/v1",
      anthropic: "https://api.minimaxi.com/anthropic",
    },
    website: "https://platform.minimaxi.com",
    keysUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  {
    id: "stepfun",
    name: "StepFun",
    kind: "vendor",
    endpoints: {
      openai: "https://api.stepfun.ai/step_plan/v1",
      anthropic: "https://api.stepfun.ai/step_plan",
    },
    website: "https://platform.stepfun.ai",
    keysUrl: "https://platform.stepfun.ai/interface-key",
    regionLabel: "Plan",
    regions: [
      {
        id: "plan",
        name: "Step Plan",
        endpoints: {
          openai: "https://api.stepfun.ai/step_plan/v1",
          anthropic: "https://api.stepfun.ai/step_plan",
        },
      },
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://api.stepfun.ai/v1",
          anthropic: "https://api.stepfun.ai",
        },
      },
    ],
  },
  {
    id: "stepfun-cn",
    name: "StepFun (China)",
    kind: "vendor",
    endpoints: {
      openai: "https://api.stepfun.com/step_plan/v1",
      anthropic: "https://api.stepfun.com/step_plan",
    },
    website: "https://platform.stepfun.com",
    keysUrl: "https://platform.stepfun.com/interface-key",
    regionLabel: "Plan",
    regions: [
      {
        id: "plan",
        name: "Step Plan",
        endpoints: {
          openai: "https://api.stepfun.com/step_plan/v1",
          anthropic: "https://api.stepfun.com/step_plan",
        },
      },
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://api.stepfun.com/v1",
          anthropic: "https://api.stepfun.com",
        },
      },
    ],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    kind: "vendor",
    endpoints: {
      openai: "https://token-plan-cn.xiaomimimo.com/v1",
      "openai-responses": "https://token-plan-cn.xiaomimimo.com/v1",
      anthropic: "https://token-plan-cn.xiaomimimo.com/anthropic",
    },
    website: "https://platform.xiaomimimo.com",
    keysUrl: "https://platform.xiaomimimo.com/token-plan",
    note: "Token Plan · pay as you go",
    regions: [
      {
        id: "plan-cn",
        name: "Plan · China",
        endpoints: {
          openai: "https://token-plan-cn.xiaomimimo.com/v1",
          "openai-responses": "https://token-plan-cn.xiaomimimo.com/v1",
          anthropic: "https://token-plan-cn.xiaomimimo.com/anthropic",
        },
      },
      {
        id: "plan-sgp",
        name: "Plan · Singapore",
        endpoints: {
          openai: "https://token-plan-sgp.xiaomimimo.com/v1",
          "openai-responses": "https://token-plan-sgp.xiaomimimo.com/v1",
          anthropic: "https://token-plan-sgp.xiaomimimo.com/anthropic",
        },
      },
      {
        id: "plan-ams",
        name: "Plan · Europe",
        endpoints: {
          openai: "https://token-plan-ams.xiaomimimo.com/v1",
          "openai-responses": "https://token-plan-ams.xiaomimimo.com/v1",
          anthropic: "https://token-plan-ams.xiaomimimo.com/anthropic",
        },
      },
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://api.xiaomimimo.com/v1",
          "openai-responses": "https://api.xiaomimimo.com/v1",
          anthropic: "https://api.xiaomimimo.com/anthropic",
        },
      },
    ],
  },
  {
    id: "longcat",
    name: "LongCat",
    kind: "vendor",
    endpoints: {
      openai: "https://api.longcat.chat/openai/v1",
      "openai-responses": "https://api.longcat.chat/openai/v1",
      anthropic: "https://api.longcat.chat/anthropic",
    },
    website: "https://longcat.chat/platform/docs/zh/api-docs",
    keysUrl: "https://longcat.chat/platform/api_keys",
  },
  {
    id: "baidu-qianfan",
    name: "Baidu Qianfan",
    kind: "vendor",
    endpoints: {
      openai: "https://qianfan.baidubce.com/v2/tokenplan/personal",
      "openai-responses": "https://qianfan.baidubce.com/v2/tokenplan/personal",
      anthropic: "https://qianfan.baidubce.com/anthropic/tokenplan/personal",
    },
    website: "https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6",
    keysUrl: "https://console.bce.baidu.com/qianfan/resource/token-plan",
    note: "Token Plan · pay as you go",
    regionLabel: "Plan",
    regions: [
      {
        id: "personal",
        name: "Token Plan Personal",
        endpoints: {
          openai: "https://qianfan.baidubce.com/v2/tokenplan/personal",
          "openai-responses": "https://qianfan.baidubce.com/v2/tokenplan/personal",
          anthropic: "https://qianfan.baidubce.com/anthropic/tokenplan/personal",
        },
      },
      {
        id: "team",
        name: "Token Plan Enterprise",
        endpoints: {
          openai: "https://qianfan.baidubce.com/v2/tokenplan/team",
          "openai-responses": "https://qianfan.baidubce.com/v2/tokenplan/team",
          anthropic: "https://qianfan.baidubce.com/anthropic/tokenplan/team",
        },
      },
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://qianfan.baidubce.com/v2",
          "openai-responses": "https://qianfan.baidubce.com/v2",
          anthropic: "https://qianfan.baidubce.com/anthropic",
        },
        keysUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
      },
    ],
  },
  {
    id: "tencent-cloud",
    name: "Tencent Cloud",
    kind: "vendor",
    endpoints: {
      openai: "https://tokenhub.tencentmaas.com/plan/v3",
      "openai-responses": "https://tokenhub.tencentmaas.com/plan/v3",
      anthropic: "https://tokenhub.tencentmaas.com/plan/anthropic",
    },
    website: "https://cloud.tencent.com/document/product/1823/130060",
    keysUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan",
    note: "Token Plan · pay as you go",
    regions: [
      {
        id: "plan",
        name: "Plan · China",
        endpoints: {
          openai: "https://tokenhub.tencentmaas.com/plan/v3",
          "openai-responses": "https://tokenhub.tencentmaas.com/plan/v3",
          anthropic: "https://tokenhub.tencentmaas.com/plan/anthropic",
        },
        website: "https://cloud.tencent.com/document/product/1823/130060",
        keysUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan",
      },
      {
        id: "cn",
        name: "Pay as you go · China",
        endpoints: {
          openai: "https://tokenhub.tencentmaas.com/v1",
          "openai-responses": "https://tokenhub.tencentmaas.com/v1",
          anthropic: "https://tokenhub.tencentmaas.com",
        },
        website: "https://cloud.tencent.com/document/product/1823/130078",
        keysUrl: "https://console.cloud.tencent.com/tokenhub/apikey",
        catalog: "tencent-tokenhub",
      },
      {
        id: "intl",
        name: "Pay as you go · Global",
        endpoints: {
          openai: "https://tokenhub-intl.tencentmaas.com/v1",
          "openai-responses": "https://tokenhub-intl.tencentmaas.com/v1",
          anthropic: "https://tokenhub-intl.tencentmaas.com",
        },
        website: "https://www.tencentcloud.com/document/product/1300/78939",
        keysUrl: "https://console.tencentcloud.com/tokenhub/apikey",
        catalog: "tencent-tokenhub",
      },
      {
        id: "enterprise-intl",
        name: "Enterprise plan · Global",
        endpoints: {
          openai: "https://tokenhub-intl.tencentmaas.com/plan/v3",
          "openai-responses": "https://tokenhub-intl.tencentmaas.com/plan/v3",
          anthropic: "https://tokenhub-intl.tencentmaas.com/plan/anthropic",
        },
        website: "https://cloud.tencent.com/document/product/1823/130659",
        keysUrl: "https://console.tencentcloud.com/tokenhub/tokenplan",
      },
    ],
  },
  {
    id: "huaweicloud",
    name: "Huawei Cloud",
    fullName: "Huawei Cloud MaaS",
    kind: "vendor",
    endpoints: {
      openai: "https://api.modelarts-maas.com/plan/v2",
      anthropic: "https://api.modelarts-maas.com/plan/anthropic",
    },
    website: "https://support.huaweicloud.com/Token-plan-maas/tokenplan-maas-0001.html",
    keysUrl: "https://console.huaweicloud.com/modelarts/?#/model-studio/authmanage",
    note: "Token Plan · 西南-贵阳一",
    regionLabel: "Plan",
    regions: [
      {
        id: "plan",
        name: "Token Plan",
        endpoints: {
          openai: "https://api.modelarts-maas.com/plan/v2",
          anthropic: "https://api.modelarts-maas.com/plan/anthropic",
        },
      },
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://api.modelarts-maas.com/openai/v1",
          anthropic: "https://api.modelarts-maas.com/anthropic",
        },
      },
    ],
  },
  {
    id: "volcengine",
    name: "Volcengine Ark",
    kind: "vendor",
    endpoints: {
      openai: "https://ark.cn-beijing.volces.com/api/coding/v3",
      "openai-responses": "https://ark.cn-beijing.volces.com/api/coding/v3",
      anthropic: "https://ark.cn-beijing.volces.com/api/coding",
    },
    website: "https://www.volcengine.com/docs/82379/1925114",
    keysUrl: "https://ark.volcengine.com/region:cn-beijing/apikey",
    note: "火山方舟 · Coding / Agent Plan",
    regionLabel: "Plan",
    regions: [
      {
        id: "coding",
        name: "Coding Plan",
        endpoints: {
          openai: "https://ark.cn-beijing.volces.com/api/coding/v3",
          "openai-responses": "https://ark.cn-beijing.volces.com/api/coding/v3",
          anthropic: "https://ark.cn-beijing.volces.com/api/coding",
        },
      },
      {
        id: "agent",
        name: "Agent Plan",
        endpoints: {
          openai: "https://ark.cn-beijing.volces.com/api/plan/v3",
          "openai-responses": "https://ark.cn-beijing.volces.com/api/plan/v3",
          anthropic: "https://ark.cn-beijing.volces.com/api/plan",
        },
      },
      {
        id: "api",
        name: "Pay as you go",
        endpoints: {
          openai: "https://ark.cn-beijing.volces.com/api/v3",
          "openai-responses": "https://ark.cn-beijing.volces.com/api/v3",
        },
      },
    ],
  },
  {
    id: "qwen",
    name: "Qwen",
    kind: "vendor",
    endpoints: {
      openai: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      anthropic: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    },
    website: "https://modelstudio.console.alibabacloud.com",
    keysUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
    note: "DashScope · intl",
  },
  {
    id: "qwen-cn",
    name: "Qwen (China)",
    kind: "vendor",
    endpoints: {
      openai: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic: "https://dashscope.aliyuncs.com/apps/anthropic",
    },
    website: "https://bailian.console.aliyun.com",
    keysUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    note: "DashScope · China",
  },
  {
    id: "qwen-token-plan",
    name: "Qwen Plan",
    fullName: "Qwen Token Plan",
    kind: "vendor",
    endpoints: {
      openai: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
      anthropic: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
    },
    website: "https://platform.qianwenai.com/docs/token-plan/overview",
    keysUrl: "https://platform.qianwenai.com/home/analytics/token-plan/individual",
    note: "Qwen AI platform · subscription",
  },
  {
    id: "bailian-token-plan",
    name: "Bailian Plan",
    fullName: "Bailian Token Plan",
    kind: "vendor",
    endpoints: {
      openai: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      anthropic: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    },
    website: "https://help.aliyun.com/zh/model-studio/token-plan-overview",
    keysUrl: "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal",
    note: "Alibaba Cloud Bailian · subscription",
    // Its decision model, decision-model-preview, answers on System One at
    // the same host with the same key; a routing group can be classified by it.
    decide: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  },
  {
    // myna's bailian-decision: Jev's System One at the host of the key's
    // workspace, {WorkspaceId} filled in by `provider set … workspace=`.
    // It routes groups and serves no model of its own.
    id: "bailian-decision",
    name: "Bailian Decision Model",
    kind: "vendor",
    endpoints: {},
    decide: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    website: "https://help.aliyun.com/zh/model-studio/decision-model-preview",
    keysUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    note: "routes groups · picks model and effort",
    regionLabel: "Plan",
    regions: [
      {
        id: "cn-beijing",
        name: "Workspace · Beijing",
        endpoints: {},
        decide: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      },
      {
        id: "ap-southeast-1",
        name: "Workspace · Singapore",
        endpoints: {},
        decide: "https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        keysUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
      },
      {
        id: "token-plan",
        name: "Token Plan · Beijing",
        endpoints: {},
        decide: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        keysUrl: "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal",
      },
    ],
  },
  {
    id: "qwencloud-token-plan",
    name: "Qwen Cloud Plan",
    fullName: "Qwen Cloud Token Plan",
    kind: "vendor",
    endpoints: {
      openai: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
      anthropic: "https://token-plan.maas.qwencloudapi.com/apps/anthropic",
    },
    website: "https://docs.qwencloud.com/token-plan/overview",
    keysUrl: "https://home.qwencloud.com/analytics/token-plan/individual",
    note: "Qwen Cloud · subscription",
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "vendor",
    endpoints: { openai: "https://api.mistral.ai/v1" },
    website: "https://console.mistral.ai",
    keysUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "vendor",
    endpoints: {
      openai: "https://api.groq.com/openai/v1",
      "openai-responses": "https://api.groq.com/openai/v1",
    },
    website: "https://console.groq.com",
    keysUrl: "https://console.groq.com/keys",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    kind: "vendor",
    endpoints: { openai: "https://ollama.com/v1", anthropic: "https://ollama.com" },
    website: "https://docs.ollama.com/cloud",
    keysUrl: "https://ollama.com/settings/keys",
    note: "cloud models, with an API key",
  },
  {
    id: "nous",
    name: "Nous Portal",
    kind: "vendor",
    endpoints: { openai: "https://inference-api.nousresearch.com/v1" },
    website: "https://portal.nousresearch.com",
    keysUrl: "https://portal.nousresearch.com",
    note: "Nous Research · Hermes and other models",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "relay",
    endpoints: { openai: "https://openrouter.ai/api/v1", anthropic: "https://openrouter.ai/api" },
    website: "https://openrouter.ai",
    keysUrl: "https://openrouter.ai/keys",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    kind: "relay",
    endpoints: {
      openai: "https://opencode.ai/zen/go/v1",
      "openai-responses": "https://opencode.ai/zen/go/v1",
      anthropic: "https://opencode.ai/zen/go",
    },
    website: "https://opencode.ai/docs/go",
    keysUrl: "https://opencode.ai/auth",
    note: "open coding models, $10/month",
  },
  {
    id: "clinepass",
    name: "ClinePass",
    kind: "relay",
    endpoints: { openai: "https://api.cline.bot/api/v1" },
    website: "https://docs.cline.bot/getting-started/clinepass",
    keysUrl: "https://app.cline.bot",
    note: "open coding models, $9.99/month",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    kind: "relay",
    endpoints: {
      openai: "https://opencode.ai/zen/v1",
      "openai-responses": "https://opencode.ai/zen/v1",
      anthropic: "https://opencode.ai/zen",
    },
    website: "https://opencode.ai/docs/zen",
    keysUrl: "https://opencode.ai/auth",
  },
  {
    id: "kilo",
    name: "Kilo Gateway",
    kind: "relay",
    endpoints: { openai: "https://api.kilo.ai/api/openrouter" },
    website: "https://kilo.ai/docs/gateway",
    keysUrl: "https://app.kilo.ai",
    note: "free models with no key",
  },
  {
    id: "commandcode",
    name: "Command Code",
    kind: "relay",
    endpoints: {
      openai: "https://api.commandcode.ai/provider/v1",
      "openai-responses": "https://api.commandcode.ai/provider/v1",
      anthropic: "https://api.commandcode.ai/provider",
    },
    website: "https://commandcode.ai/docs/provider",
    keysUrl: "https://commandcode.ai/settings/keys",
  },
  {
    id: "together",
    name: "Together AI",
    kind: "relay",
    endpoints: { openai: "https://api.together.xyz/v1" },
    website: "https://api.together.ai",
    keysUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    kind: "relay",
    endpoints: { openai: "https://api.fireworks.ai/inference/v1" },
    website: "https://fireworks.ai",
    keysUrl: "https://app.fireworks.ai/settings/users/api-keys",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    kind: "relay",
    endpoints: { openai: "https://api.siliconflow.cn/v1" },
    website: "https://cloud.siliconflow.cn",
    keysUrl: "https://cloud.siliconflow.cn/account/ak",
    regions: [
      {
        id: "cn",
        name: "China",
        endpoints: { openai: "https://api.siliconflow.cn/v1" },
      },
      {
        id: "intl",
        name: "Global",
        endpoints: { openai: "https://api.siliconflow.com/v1" },
        website: "https://cloud.siliconflow.com",
        keysUrl: "https://cloud.siliconflow.com/account/ak",
      },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "relay",
    endpoints: { openai: "https://integrate.api.nvidia.com/v1" },
    website: "https://build.nvidia.com",
    keysUrl: "https://build.nvidia.com/settings/api-keys",
  },
  {
    id: "modelscope",
    name: "ModelScope",
    kind: "relay",
    endpoints: {
      openai: "https://api-inference.modelscope.cn/v1",
      "openai-responses": "https://api-inference.modelscope.cn/v1",
    },
    website: "https://modelscope.cn/docs/model-service/API-Inference/intro",
    keysUrl: "https://modelscope.cn/my/myaccesstoken",
    note: "魔搭 · API-Inference",
  },
  {
    id: "aihubmix",
    name: "AiHubMix",
    kind: "relay",
    endpoints: { openai: "https://aihubmix.com/v1", anthropic: "https://aihubmix.com" },
    website: "https://aihubmix.com",
    keysUrl: "https://console.aihubmix.com/token",
  },
  {
    id: "pipellm",
    name: "PipeLLM",
    kind: "relay",
    endpoints: {
      openai: "https://api.pipellm.ai/openai/v1",
      "openai-responses": "https://api.pipellm.ai/v1",
      anthropic: "https://api.pipellm.ai",
    },
    website: "https://www.pipellm.ai",
    keysUrl: "https://console.pipellm.ai",
  },
  {
    id: "302ai",
    name: "302.AI",
    kind: "relay",
    endpoints: { openai: "https://api.302.ai/v1", anthropic: "https://api.302.ai" },
    website: "https://302.ai",
    keysUrl: "https://302.ai/api-keys/list",
  },
  {
    id: "cherryin",
    name: "CherryIN",
    kind: "relay",
    endpoints: {
      openai: "https://open.cherryin.ai/v1",
      "openai-responses": "https://open.cherryin.ai/v1",
      anthropic: "https://open.cherryin.ai",
    },
    website: "https://open.cherryin.ai",
    keysUrl: "https://open.cherryin.ai/console/token",
  },
  {
    id: "yylx",
    name: "鱼鱼连线",
    kind: "relay",
    endpoints: { openai: "https://app.yylx.io/v1", anthropic: "https://app.yylx.io" },
    website: "https://yylx.io",
    keysUrl: "https://app.yylx.io/keys",
    regions: [
      {
        id: "auto",
        name: "Auto",
        endpoints: { openai: "https://app.yylx.io/v1", anthropic: "https://app.yylx.io" },
      },
      {
        id: "global",
        name: "Global",
        endpoints: { openai: "https://global.yylx.io/v1", anthropic: "https://global.yylx.io" },
      },
      {
        id: "cn",
        name: "China Mainland",
        endpoints: { openai: "https://cn.yylx.io/v1", anthropic: "https://cn.yylx.io" },
      },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    endpoints: { openai: "http://localhost:11434/v1", anthropic: "http://localhost:11434" },
    website: "https://ollama.com",
    note: "your local models",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "local",
    endpoints: { openai: "http://localhost:1234/v1" },
    website: "https://lmstudio.ai",
    note: "local server, port 1234 by default",
  },
];
