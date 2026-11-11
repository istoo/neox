import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileDirectoryPlugin } from "./compiler.js";
import { evaluateBundle } from "./bundle-evaluator.js";

const CALC_PLUGIN = fileURLToPath(new URL("./test-fixtures/myna-tools-calc", import.meta.url));

interface HookCall {
  name: string;
  handler: (input: { request: Record<string, unknown> }) => Promise<unknown>;
}

async function loadHooks(directory: string): Promise<HookCall[]> {
  const bundles = await compileDirectoryPlugin(directory, "0.15.0");
  if (!bundles.serverBundle) throw new Error("No server bundle");
  const setup = evaluateBundle(bundles.serverBundle);
  const hooks: HookCall[] = [];
  await setup({
    addHook(name: string, handler: HookCall["handler"]) {
      hooks.push({ name, handler });
      return () => undefined;
    },
  } as never);
  return hooks;
}

describe("myna calc pilot plugin", () => {
  it("adds calc_eval, calc_convert and calc_date to every interactive agent", async () => {
    const hooks = await loadHooks(CALC_PLUGIN);
    const open = hooks.find((hook) => hook.name === "agent.open.before");
    expect(open).toBeDefined();

    const result = (await open!.handler({
      request: { purpose: "interactive", tools: [], labels: {} },
    })) as { tools: { name: string }[] };

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "calc_eval",
      "calc_convert",
      "calc_date",
    ]);
  });

  it("keeps history opens untouched", async () => {
    const hooks = await loadHooks(CALC_PLUGIN);
    const open = hooks.find((hook) => hook.name === "agent.open.before")!;

    await expect(open.handler({ request: { purpose: "history", tools: [] } })).resolves.toBe(
      undefined,
    );
  });

  it("evaluates arithmetic exactly", async () => {
    const hooks = await loadHooks(CALC_PLUGIN);
    const open = hooks.find((hook) => hook.name === "agent.open.before")!;
    const result = (await open.handler({
      request: { purpose: "interactive", tools: [] },
    })) as {
      tools: {
        name: string;
        execute(input: unknown): Promise<{ structuredContent?: { exact?: string } }>;
      }[];
    };
    const evaluate = result.tools.find((tool) => tool.name === "calc_eval");

    const answer = await evaluate!.execute({ expression: "0.1+0.2" });

    expect(answer.structuredContent?.exact).toBe("3/10");
  });
});
