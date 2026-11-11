import type { PluginServerContext } from "@neolix/plugin/server";
import { greet, greetRpc, notesSearchRpc, searchNotes } from "./server/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetRpc, greet);
  server.handle(notesSearchRpc, searchNotes);
  return () => {};
}
