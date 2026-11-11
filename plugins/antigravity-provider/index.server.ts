import type { PluginServerContext } from "@neolix/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createAntigravityProvider());
  return () => {};
}
