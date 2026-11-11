import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "@neolix/server/gateway-config";
import { GATEWAY_PROVIDER_PRESETS } from "@neolix/protocol/gateway-presets";
import {
  runAccountCapCommand,
  runAccountConcurrencyCommand,
  runAccountModelsCommand,
  runAccountWeightCommand,
  runAddCommand,
  runAtOnceCommand,
  runAutoIncludeCommand,
  runFallbackCommand,
  runIconCommand,
  runKeyCommand,
  runListedCommand,
  runModelsCommand,
  runOnOffCommand,
  runPoolCommand,
  runPresetsCommand,
  runProvidersCommand,
  runProvidersJson,
  runQueueCommand,
  runQuotaRestCommand,
  runRefreshCommand,
  runRefreshEveryCommand,
  runRemoveCommand,
  runRestCapCommand,
  runRpmCommand,
  runSetCommand,
  runShowCommand,
  runSpendCapCommand,
  runTestCommand,
} from "./gateway-commands.js";
import { createPresetsCommand, createProviderCommand, createProvidersCommand } from "./index.js";

// These tests start a real GatewayConfigStore (file watch included) per case;
// the default 5s is tight while other workspaces build in parallel.
vi.setConfig({ testTimeout: 20_000 });

const homes: string[] = [];

const CONFIG: GatewayConfig = GatewayConfigSchema.parse({
  providers: [
    {
      id: "acme",
      label: "Acme",
      protocol: "anthropic",
      baseUrl: "https://api.acme.test",
      apiKey: "sk-acme-123456789",
      accounts: [
        { id: "one", apiKey: "sk-one" },
        { id: "two", apiKey: "sk-two" },
      ],
      models: [{ id: "alpha" }, { id: "beta" }],
    },
  ],
});

async function homeWith(config: GatewayConfig = CONFIG): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "neolix-provider-"));
  homes.push(home);
  await writeFile(join(home, "gateway.json"), `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

async function readConfig(home: string): Promise<GatewayConfig> {
  return JSON.parse(await readFile(join(home, "gateway.json"), "utf8")) as GatewayConfig;
}

function onlyProvider(config: GatewayConfig) {
  return config.providers[0]!;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("neox providers", () => {
  it("lists each provider with its host, key and model count", async () => {
    const home = await homeWith();
    const lines = await runProvidersCommand({ home });
    expect(lines.join("\n")).toContain("Acme");
    expect(lines.join("\n")).toContain("acme");
    expect(lines.join("\n")).toContain("api.acme.test");
    expect(lines.join("\n")).toContain("sk-a…6789");
    expect(lines.join("\n")).toContain("2 of 2 models");
  });

  it("says there are none yet", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    expect((await runProvidersCommand({ home })).join("\n")).toContain("no providers yet");
  });

  it("says which agents start on each provider", async () => {
    const home = await homeWith();
    const lines = await runProvidersCommand({ home }, new Map([["acme", ["codex", "claude"]]]));
    expect(lines.join("\n")).toContain("← codex, claude");
  });

  it("reports providers as JSON without the key", async () => {
    const home = await homeWith();
    const summaries = await runProvidersJson({ home }, new Map([["acme", ["codex"]]]));
    expect(summaries).toEqual([
      {
        id: "acme",
        label: "Acme",
        host: "api.acme.test",
        enabled: true,
        hasKey: true,
        models: { exposed: 2, total: 2 },
        fallback: [],
        usedBy: ["codex"],
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("sk-a");
  });
});

describe("neox provider add", () => {
  it("adds a preset vendor with its key and endpoint", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    const lines = await runAddCommand(["deepseek", "sk-deep-123456"], { home });
    expect(lines[0]).toBe("✓ added DeepSeek (deepseek)");
    const saved = onlyProvider(await readConfig(home));
    expect(saved.id).toBe("deepseek");
    expect(saved.protocol).toBe("openai");
    expect(saved.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(saved.apiKey).toBe("sk-deep-123456");
  });

  it("adds a second copy of a preset under the next free id", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await runAddCommand(["deepseek", "sk-deep-123456"], { home });
    await runAddCommand(["deepseek", "sk-deep-999999"], { home });
    expect((await readConfig(home)).providers.map((held) => held.id)).toEqual([
      "deepseek",
      "deepseek-2",
    ]);
  });

  it("adds a custom vendor from k=v pairs, headers included", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await runAddCommand(
      ["My Relay", "url=https://relay.example.test/v1", "key=sk-relay-123456", "header.X-Org=acme"],
      { home },
    );
    const saved = onlyProvider(await readConfig(home));
    expect(saved.id).toBe("my-relay");
    expect(saved.baseUrl).toBe("https://relay.example.test/v1");
    expect(saved.headers).toEqual({ "X-Org": "acme" });
  });

  it("refuses a custom vendor with no address", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await expect(runAddCommand(["My Relay", "key=sk-123456789"], { home })).rejects.toThrow(
      /needs an address/,
    );
  });
});

describe("neox provider set", () => {
  it("changes pairs the way add reads them", async () => {
    const home = await homeWith();
    await runSetCommand(
      ["acme", "name=Acme Two", "responses=https://api.acme.test/v1", "unmasked=yes", "free=yes"],
      { home },
    );
    const saved = onlyProvider(await readConfig(home));
    expect(saved.label).toBe("Acme Two");
    expect(saved.protocol).toBe("openai-responses");
    expect(saved.baseUrl).toBe("https://api.acme.test/v1");
    expect(saved.unredacted).toBe(true);
    expect(saved.countFree).toBe(true);
  });

  it("keeps an address per API, as myna's provider does", async () => {
    const home = await homeWith();
    await runSetCommand(
      [
        "acme",
        "chat=https://api.acme.test/v1",
        "anthropic=https://anthropic.acme.test",
        "gemini=https://gemini.acme.test/v1beta",
      ],
      { home },
    );
    const saved = onlyProvider(await readConfig(home));
    expect(saved.wires).toEqual({
      openai: "https://api.acme.test/v1",
      anthropic: "https://anthropic.acme.test",
      gemini: "https://gemini.acme.test/v1beta",
    });
    expect(saved.protocol).toBe("gemini");
    expect(saved.baseUrl).toBe("https://gemini.acme.test/v1beta");
  });

  it("refuses an unknown field, and writes nothing", async () => {
    const home = await homeWith();
    await expect(runSetCommand(["acme", "decidex=https://decide.test"], { home })).rejects.toThrow(
      /unknown field/,
    );
    expect(onlyProvider(await readConfig(home)).label).toBe("Acme");
  });

  it("refuses an unknown field with the usage", async () => {
    const home = await homeWith();
    await expect(runSetCommand(["acme", "nonsense=1"], { home })).rejects.toThrow(
      /unknown field "nonsense"/,
    );
  });

  it("renames a provider by id", async () => {
    const home = await homeWith();
    await runSetCommand(["acme", "id=acme-two"], { home });
    expect(onlyProvider(await readConfig(home)).id).toBe("acme-two");
  });
});

describe("neox provider region, plan, decide and access keys", () => {
  function presetConfig(id: string, extra: Record<string, unknown> = {}): GatewayConfig {
    const preset = GATEWAY_PROVIDER_PRESETS.find((held) => held.id === id)!;
    const protocol = (["openai", "anthropic", "openai-responses", "gemini"] as const).find(
      (held) => preset.endpoints[held] !== undefined,
    )!;
    return GatewayConfigSchema.parse({
      providers: [
        {
          id,
          label: preset.name,
          preset: id,
          protocol,
          baseUrl: preset.endpoints[protocol],
          ...extra,
        },
      ],
    });
  }

  it("moves a preset's endpoints to the picked plan", async () => {
    const home = await homeWith(presetConfig("zhipu"));
    await runSetCommand(["zhipu", "region=coding"], { home });
    const saved = onlyProvider(await readConfig(home));
    expect(saved.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(saved.protocol).toBe("openai");
    expect(saved.label).toBe("Zhipu GLM");
  });

  it("takes the plan on add too", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await runAddCommand(["zhipu", "sk-dlhe-06314098", "region=coding"], { home });
    const saved = onlyProvider(await readConfig(home));
    expect(saved.preset).toBe("zhipu");
    expect(saved.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
  });

  it("or plan= names the same picker, and an old id still resolves", async () => {
    const home = await homeWith(presetConfig("tencent-cloud"));
    await runSetCommand(["tencent-cloud", "plan=enterprise"], { home });
    expect(onlyProvider(await readConfig(home)).baseUrl).toBe(
      "https://tokenhub.tencentmaas.com/plan/v3",
    );
  });

  it("lists the plans when one is not known", async () => {
    const home = await homeWith(presetConfig("zhipu"));
    await expect(runSetCommand(["zhipu", "region=nope"], { home })).rejects.toThrow(/api, coding/);
  });

  it("refuses region= on a provider with no regions", async () => {
    const home = await homeWith();
    await expect(runSetCommand(["acme", "region=coding"], { home })).rejects.toThrow(
      /no regions or plans/,
    );
  });

  it("stores decide=, and workspace= fills its placeholder", async () => {
    const home = await homeWith();
    await runSetCommand(
      ["acme", "decide=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"],
      { home },
    );
    await runSetCommand(["acme", "workspace=ws-1"], { home });
    expect(onlyProvider(await readConfig(home)).decide).toBe(
      "https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("refuses workspace= when the decision API names none", async () => {
    const home = await homeWith();
    await runSetCommand(["acme", "decide=https://decide.test/v1"], { home });
    await expect(runSetCommand(["acme", "workspace=ws-1"], { home })).rejects.toThrow(/names none/);
  });

  it("stores a Volcengine access key and its secret", async () => {
    const home = await homeWith();
    await runSetCommand(["acme", "access.key=AKLT-test", "access.secret=secret-1"], { home });
    const saved = onlyProvider(await readConfig(home));
    expect(saved.accessKeyId).toBe("AKLT-test");
    expect(saved.secretAccessKey).toBe("secret-1");
  });

  it("adds a preset with its decision API", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await runAddCommand(["bailian-token-plan", "sk-sp-test123456"], { home });
    const saved = onlyProvider(await readConfig(home));
    expect(saved.preset).toBe("bailian-token-plan");
    expect(saved.decide).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  });

  it("adds the Bailian decision preset, moves its region and fills the workspace", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await runAddCommand(["bailian-decision", "sk-dlhe-06314098"], { home });
    let saved = onlyProvider(await readConfig(home));
    expect(saved.decide).toBe(
      "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(saved.modelMode).toBe("none");
    await runSetCommand(["bailian-decision", "region=ap-southeast-1"], { home });
    saved = onlyProvider(await readConfig(home));
    expect(saved.decide).toBe(
      "https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    await runSetCommand(["bailian-decision", "workspace=ws-9"], { home });
    expect(onlyProvider(await readConfig(home)).decide).toBe(
      "https://ws-9.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("wires a Vertex preset's project, location, credentials and impersonation", async () => {
    const home = await homeWith({ ...CONFIG, providers: [] });
    await runAddCommand(["google-vertex", "project=my-project"], { home });
    await runSetCommand(
      [
        "google-vertex",
        "location=us-central1",
        "credentials=/tmp/sa.json",
        "impersonate=sa@my-project.iam.gserviceaccount.com",
      ],
      { home },
    );
    const saved = onlyProvider(await readConfig(home));
    expect(saved.vertex).toEqual({
      project: "my-project",
      location: "us-central1",
      credentials: "/tmp/sa.json",
      impersonate: "sa@my-project.iam.gserviceaccount.com",
    });
  });
});

describe("neox provider key and icon", () => {
  it("changes the key and prints it masked", async () => {
    const home = await homeWith();
    const lines = await runKeyCommand(["acme", "sk-new-key-987654"], { home });
    expect(lines).toEqual(["✓ Acme key sk-n…7654"]);
    expect(onlyProvider(await readConfig(home)).apiKey).toBe("sk-new-key-987654");
  });

  it("gives an icon, and generic for an empty one", async () => {
    const home = await homeWith();
    expect(await runIconCommand(["acme", ""], { home })).toEqual(["✓ Acme icon generic"]);
    expect(onlyProvider(await readConfig(home)).icon).toBe("generic");
  });
});

describe("neox provider fallback", () => {
  it("sets fallbacks and prints the chain", async () => {
    const home = await homeWith();
    const lines = await runFallbackCommand(["acme", "acme/beta"], { home });
    expect(lines.join("\n")).toContain("falls back to acme/beta");
    expect(onlyProvider(await readConfig(home)).fallback).toEqual(["acme/beta"]);
  });

  it("clears them with none", async () => {
    const home = await homeWith();
    const lines = await runFallbackCommand(["acme", "none"], { home });
    expect(lines.join("\n")).toContain("has no fallback");
  });

  it("refuses a model or group it doesn't know", async () => {
    const home = await homeWith();
    await expect(runFallbackCommand(["acme", "elsewhere/model"], { home })).rejects.toThrow(
      /knows no model or group/,
    );
  });
});

describe("neox provider models and refresh", () => {
  it("picks models by replacing the list", async () => {
    const home = await homeWith();
    await runModelsCommand("acme", ["beta"], { home });
    const saved = onlyProvider(await readConfig(home));
    expect(saved.modelMode).toBe("picked");
    expect(saved.models.filter((model) => model.picked).map((model) => model.id)).toEqual(["beta"]);
  });

  it("adds and takes away picks with +id and -id", async () => {
    const home = await homeWith();
    await runModelsCommand("acme", ["+beta"], { home });
    expect(
      onlyProvider(await readConfig(home))
        .models.filter((m) => m.picked)
        .map((m) => m.id),
    ).toEqual(["alpha", "beta"]);
    await runModelsCommand("acme", ["-alpha"], { home });
    expect(
      onlyProvider(await readConfig(home))
        .models.filter((m) => m.picked)
        .map((m) => m.id),
    ).toEqual(["beta"]);
  });

  it("all serves the vendor's list again and none serves nothing", async () => {
    const home = await homeWith();
    await runModelsCommand("acme", ["all"], { home });
    expect(onlyProvider(await readConfig(home)).modelMode).toBe("list");
    await runModelsCommand("acme", ["none"], { home });
    expect(onlyProvider(await readConfig(home)).modelMode).toBe("none");
  });

  it("fetches a list through the daemon RPC it is given", async () => {
    const home = await homeWith();
    const lines = await runModelsCommand("acme", [], { home }, async () => ({
      models: ["alpha", "gamma"],
    }));
    expect(lines[0]).toBe("✓ 2 models from api.acme.test");
    const saved = onlyProvider(await readConfig(home));
    expect(saved.models.map((model) => model.id)).toEqual(["alpha", "gamma"]);
  });

  it("refresh is the same fetch", async () => {
    const home = await homeWith();
    const lines = await runRefreshCommand("acme", { home }, async () => ({ models: ["alpha"] }));
    expect(lines[0]).toBe("✓ 1 models from api.acme.test");
  });
});

describe("neox provider refresh-every and auto-include", () => {
  it("sets and clears the refresh interval", async () => {
    const home = await homeWith();
    expect((await runRefreshEveryCommand(["acme", "6h"], { home })).join("\n")).toContain(
      "every 6 hours",
    );
    expect(onlyProvider(await readConfig(home)).refreshEveryMs).toBe(6 * 3_600_000);
    expect((await runRefreshEveryCommand(["acme", "off"], { home })).join("\n")).toContain(
      "only when asked",
    );
    expect(onlyProvider(await readConfig(home)).refreshEveryMs).toBeUndefined();
  });

  it("refuses an interval under ten minutes", async () => {
    const home = await homeWith();
    await expect(runRefreshEveryCommand(["acme", "1m"], { home })).rejects.toThrow(/at least 10m/);
  });

  it("sets auto-include rules and clears them", async () => {
    const home = await homeWith();
    const lines = await runAutoIncludeCommand(["acme", "gpt-*", "re:^o\\d"], { home });
    expect(lines.join("\n")).toContain("gpt-* re:^o\\d");
    expect(onlyProvider(await readConfig(home)).autoInclude).toEqual(["gpt-*", "re:^o\\d"]);
    expect((await runAutoIncludeCommand(["acme", "none"], { home })).join("\n")).toContain(
      "no auto-include rules",
    );
  });
});

describe("neox provider account-models", () => {
  it("sets and shows the models one account serves", async () => {
    const home = await homeWith();
    const lines = await runAccountModelsCommand(["acme", "one", "alpha"], { home });
    expect(lines[0]).toContain("only alpha");
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.models).toEqual(["alpha"]);
    expect((await runAccountModelsCommand(["acme", "one", "all"], { home }))[0]).toContain(
      "every model Acme serves",
    );
  });
});

describe("neox provider account-cap", () => {
  it("caps each window, and one window alone", async () => {
    const home = await homeWith();
    expect((await runAccountCapCommand(["acme", "one", "70"], { home }))[0]).toContain(
      "capped at 70% of each usage window",
    );
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.capPercent).toBe(70);
    const lines = await runAccountCapCommand(["acme", "one", "50"], { home, window: "5 hours" });
    expect(lines.join("\n")).toContain("5 hours · capped at 50%");
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.capWindows).toEqual({
      "5 hours": 50,
    });
  });

  it("clears a cap with off", async () => {
    const home = await homeWith();
    await runAccountCapCommand(["acme", "one", "70"], { home });
    expect((await runAccountCapCommand(["acme", "one", "off"], { home }))[0]).toContain(
      "no cap: used to 100%",
    );
  });
});

describe("neox provider pool", () => {
  it("orders accounts, caps them, stops at the cap and reads carefully", async () => {
    const home = await homeWith();
    const lines = await runPoolCommand("acme", {
      home,
      accounts: "two,one",
      cap: "60",
      stop: "on",
      careful: "on",
    });
    const saved = onlyProvider(await readConfig(home));
    expect(saved.accounts?.map((account) => account.id)).toEqual(["two", "one"]);
    expect(saved.accounts?.[0]?.capPercent).toBe(60);
    expect(saved.stopAtCap).toBe(true);
    expect(saved.capCareful).toBe(true);
    expect(lines.join("\n")).toContain("at the caps it answers 429");
  });
});

describe("neox provider account-concurrency", () => {
  it("sets one account's own limit, and clears it with default", async () => {
    const home = await homeWith();
    expect((await runAccountConcurrencyCommand(["acme", "one", "3"], { home }))[0]).toContain(
      "at most 3 at once (its own)",
    );
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.maxConcurrency).toBe(3);
    await runAccountConcurrencyCommand(["acme", "one", "default"], { home });
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.maxConcurrency).toBeUndefined();
  });
});

describe("neox provider spend-cap", () => {
  it("sets a key's spend cap with its period", async () => {
    const home = await homeWith();
    const lines = await runSpendCapCommand(["acme", "one", "12.5", "month"], { home });
    expect(lines[0]).toContain("$12.50 this month");
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.spendCap).toEqual({
      usd: 12.5,
      period: "month",
    });
  });

  it("clears it with off", async () => {
    const home = await homeWith();
    await runSpendCapCommand(["acme", "one", "12.5"], { home });
    expect((await runSpendCapCommand(["acme", "one", "off"], { home }))[0]).toContain(
      "no spend cap",
    );
  });
});

describe("neox provider account-weight", () => {
  it("sets a weight and says routing=weight is what counts", async () => {
    const home = await homeWith();
    const lines = await runAccountWeightCommand(["acme", "one", "3"], { home });
    expect(lines.join("\n")).toContain("one · weight 3");
    expect(lines.join("\n")).toContain("routing=weight");
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.weight).toBe(3);
  });
});

describe("neox provider queue, rpm and at-once", () => {
  it("sets the queue's length and wait", async () => {
    const home = await homeWith();
    const lines = await runQueueCommand(["acme", "5", "30"], { home });
    expect(lines[0]).toContain("5 waiting, each for 30s");
    const saved = onlyProvider(await readConfig(home));
    expect(saved.queueLength).toBe(5);
    expect(saved.queueWaitMs).toBe(30_000);
  });

  it("sets a per-account rpm, and off", async () => {
    const home = await homeWith();
    expect((await runRpmCommand(["acme", "20"], { home }))[0]).toContain(
      "at most 20 requests a minute",
    );
    expect(onlyProvider(await readConfig(home)).accounts?.[0]?.maxRpm).toBe(20);
    expect((await runRpmCommand(["acme", "off"], { home }))[0]).toContain(
      "no limit on requests a minute",
    );
  });

  it("sets how many accounts take requests at once", async () => {
    const home = await homeWith();
    expect((await runAtOnceCommand(["acme", "2"], { home }))[0]).toContain(
      "2 of its accounts or keys take requests at once",
    );
    expect(onlyProvider(await readConfig(home)).maxAccounts).toBe(2);
    expect((await runAtOnceCommand(["acme", "off"], { home }))[0]).toContain(
      "every account or key takes requests",
    );
  });
});

describe("neox provider quota-rest and rest-cap", () => {
  it("sets a duration, a time of day, and default", async () => {
    const home = await homeWith();
    expect((await runQuotaRestCommand(["acme", "6h"], { home }))[0]).toContain("sits out 6 hours");
    expect(onlyProvider(await readConfig(home)).quotaRest).toEqual({ seconds: 21_600 });
    expect((await runQuotaRestCommand(["acme", "until", "08:00"], { home }))[0]).toContain(
      "until 08:00",
    );
    expect(onlyProvider(await readConfig(home)).quotaRest).toEqual({ resetAt: "08:00" });
    expect((await runQuotaRestCommand(["acme", "default"], { home }))[0]).toContain(
      "15 minutes (Neox's own)",
    );
  });

  it("sets a rest cap, off and default", async () => {
    const home = await homeWith();
    expect((await runRestCapCommand(["acme", "1h"], { home }))[0]).toContain(
      "sits out at most 1 hour",
    );
    expect(onlyProvider(await readConfig(home)).restCapMs).toBe(3_600_000);
    expect((await runRestCapCommand(["acme", "off"], { home }))[0]).toContain(
      "fails without saying why doesn't rest",
    );
    expect(onlyProvider(await readConfig(home)).restCapMs).toBe(0);
    expect((await runRestCapCommand(["acme", "default"], { home }))[0]).toContain(
      "10 minutes, 30 when rate limited",
    );
    expect(onlyProvider(await readConfig(home)).restCapMs).toBeUndefined();
  });
});

describe("neox provider listed, off and on", () => {
  it("hides a provider's models from the list and shows them again", async () => {
    const home = await homeWith();
    expect((await runListedCommand(["acme", "no"], { home }))[0]).toContain(
      "serves only through routing groups",
    );
    expect(onlyProvider(await readConfig(home)).exposeModels).toBe(false);
    await runListedCommand(["acme", "yes"], { home });
    expect(onlyProvider(await readConfig(home)).exposeModels).toBeUndefined();
  });

  it("switches a provider off and on, keeping its keys", async () => {
    const home = await homeWith();
    expect((await runOnOffCommand("off", ["acme"], { home }))[0]).toContain("is switched off");
    expect(onlyProvider(await readConfig(home)).enabled).toBe(false);
    expect(onlyProvider(await readConfig(home)).apiKey).toBe("sk-acme-123456789");
    expect((await runOnOffCommand("on", ["acme"], { home }))[0]).toContain("is switched on");
    expect(onlyProvider(await readConfig(home)).enabled).toBeUndefined();
  });
});

describe("neox provider test", () => {
  it("sends a tiny request to each named model, through the injected RPC", async () => {
    const home = await homeWith();
    const asked: string[] = [];
    const result = await runTestCommand(
      "acme",
      ["alpha", "beta"],
      { home },
      {
        testModel: async (_provider, model) => {
          asked.push(model);
          return model === "alpha"
            ? { ok: true, status: 200, latencyMs: 12, error: null }
            : { ok: false, status: 404, latencyMs: 9, error: "no such model" };
        },
      },
    );
    expect(asked).toEqual(["alpha", "beta"]);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("✓ anthropic");
    expect(result.lines[1]).toContain("beta · 404 · no such model");
  });

  it("asks each endpoint when no model is named", async () => {
    const home = await homeWith();
    const result = await runTestCommand(
      "acme",
      [],
      { home },
      {
        detect: async () => [
          { protocol: "anthropic", ok: true, status: 200, error: null },
          { protocol: "openai", ok: false, status: 404, error: "not found" },
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("✗ openai");
  });
});

describe("neox provider rm and show", () => {
  it("removes a provider", async () => {
    const home = await homeWith();
    expect(await runRemoveCommand(["acme"], { home })).toEqual(["✓ removed Acme"]);
    expect((await readConfig(home)).providers).toEqual([]);
  });

  it("shows one provider and its exposed models", async () => {
    const home = await homeWith();
    const lines = await runShowCommand("acme", { home });
    expect(lines.join("\n")).toContain("Acme  acme");
    expect(lines.join("\n")).toContain("acme/alpha");
    expect(lines.join("\n")).toContain("acme/beta");
  });

  it("says a balance is unavailable when it cannot ask, as myna does", async () => {
    const home = await homeWith(
      GatewayConfigSchema.parse({
        providers: [
          {
            id: "acme",
            protocol: "openai",
            baseUrl: "https://api.acme.test/v1",
            balanceUrl: "https://api.acme.test/balance",
            balancePath: "data.left",
          },
        ],
      }),
    );
    const lines = await runShowCommand("acme", { home });
    expect(lines.join("\n")).toContain("balance    unavailable  no daemon to ask through");
  });

  it("adds the daemon's live balance", async () => {
    const home = await homeWith();
    const lines = await runShowCommand("acme", { home }, async () => ["  balance    12.00"]);
    expect(lines.join("\n")).toContain("balance    12.00");
  });
});

describe("neox presets", () => {
  it("lists the vendors the add command knows", () => {
    const lines = runPresetsCommand();
    expect(lines.join("\n")).toContain("deepseek");
    expect(lines.join("\n")).toContain("neox provider add deepseek <key>");
  });
});

describe("command parsing", () => {
  async function parsed(args: string[], home: string): Promise<string> {
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    const previous = process.env.NEOLIX_HOME;
    process.env.NEOLIX_HOME = home;
    try {
      await createProviderCommand().parseAsync(args, { from: "user" });
    } finally {
      spy.mockRestore();
      if (previous === undefined) {
        delete process.env.NEOLIX_HOME;
      } else {
        process.env.NEOLIX_HOME = previous;
      }
    }
    return output.join("");
  }

  it("takes `provider <id>` as myna does", async () => {
    const home = await homeWith();
    expect(await parsed(["acme"], home)).toContain("Acme  acme");
  });

  it("takes ids on `provider models` for a gateway provider", async () => {
    const home = await homeWith();
    expect(await parsed(["models", "acme", "+beta"], home)).toContain("acme/beta");
    expect(onlyProvider(await readConfig(home)).modelMode).toBe("picked");
  });

  async function parsedWithStderr(
    args: string[],
    home: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    const previous = process.env.NEOLIX_HOME;
    process.env.NEOLIX_HOME = home;
    try {
      await createProviderCommand().parseAsync(args, { from: "user" });
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (previous === undefined) {
        delete process.env.NEOLIX_HOME;
      } else {
        process.env.NEOLIX_HOME = previous;
      }
      process.exitCode = 0;
    }
    return { stdout: stdout.join(""), stderr: stderr.join("") };
  }

  it("refuses a name both a gateway provider and an agent provider use", async () => {
    const home = await homeWith(
      GatewayConfigSchema.parse({
        providers: [{ id: "codex", protocol: "openai", baseUrl: "https://api.codex.test" }],
      }),
    );
    const { stdout, stderr } = await parsedWithStderr(["models", "codex"], home);
    expect(stdout).toBe("");
    expect(stderr).toContain("both a gateway provider and an agent provider");
    expect(stderr).toContain("--gateway or --agent");
  });

  it("--gateway picks the gateway provider of a shared name", async () => {
    const home = await homeWith(
      GatewayConfigSchema.parse({
        providers: [
          {
            id: "codex",
            protocol: "openai",
            baseUrl: "https://api.codex.test",
            models: [{ id: "gpt-6" }],
          },
        ],
      }),
    );
    const { stdout, stderr } = await parsedWithStderr(
      ["models", "codex", "all", "--gateway"],
      home,
    );
    expect(stderr).toBe("");
    expect(stdout).toContain("codex/gpt-6");
  });

  it("--agent refuses ids an agent provider's list takes no notice of", async () => {
    const home = await homeWith();
    const { stderr } = await parsedWithStderr(["models", "acme", "+beta", "--agent"], home);
    expect(stderr).toContain("take no ids");
  });
});

describe("CLI surface", () => {
  it("offers the gateway verbs beside the agent provider ones", () => {
    const provider = createProviderCommand();
    const names = provider.commands.map((command) => command.name());
    for (const verb of [
      "ls",
      "models",
      "diagnostic",
      "add",
      "set",
      "key",
      "icon",
      "fallback",
      "refresh",
      "refresh-every",
      "auto-include",
      "account-models",
      "account-cap",
      "pool",
      "account-concurrency",
      "spend-cap",
      "account-weight",
      "queue",
      "rpm",
      "at-once",
      "quota-rest",
      "rest-cap",
      "listed",
      "off",
      "on",
      "test",
      "rm",
    ]) {
      expect(names).toContain(verb);
    }
  });

  it("offers providers and presets as their own top-level commands", () => {
    expect(createProvidersCommand().name()).toBe("providers");
    expect(createPresetsCommand().name()).toBe("presets");
  });
});
