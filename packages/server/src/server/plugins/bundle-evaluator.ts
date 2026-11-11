import { createRequire } from "node:module";
import * as pluginSharedRuntime from "@neolix/plugin";
import * as pluginProviderRuntime from "@neolix/plugin/server/provider";
import * as pluginAcpRuntime from "@neolix/plugin/server/acp";
import * as pluginUsageRuntime from "@neolix/plugin/server/usage";
import * as pluginOpenCodeRuntime from "@neolix/plugin/server/opencode";
import * as pluginServerRuntime from "@neolix/plugin/server";
import type { PluginServerContribution } from "@neolix/plugin/server";
import * as zod from "zod";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";

const nodeRequire = createRequire(import.meta.url);

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@neolix/plugin") return pluginSharedRuntime;
  if (name === "@neolix/plugin/server") return pluginServerRuntime;
  if (name === "@neolix/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@neolix/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@neolix/plugin/server/usage") return pluginUsageRuntime;
  if (name === "@neolix/plugin/server/opencode") return pluginOpenCodeRuntime;
  if (name === "zod") return zod;
  if (name === "@neolix/plugin/client/host") throw new Error(`${name} is private to the app host`);
  return nodeRequire(name);
}

export function evaluateBundle(bundle: string): PluginServerContribution {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
