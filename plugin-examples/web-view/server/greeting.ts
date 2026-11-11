import { greetRpc, notesSearchRpc } from "../shared/web-view";
import { readNotes } from "./notes";

export function greet(input: { name?: string; args?: string }) {
  const name = input.args?.trim() || input.name?.trim() || "世界";
  return { message: `你好，${name}！这条消息来自插件服务端 RPC。` };
}

export function searchNotes(input: { query: string }) {
  return { items: readNotes(input.query) };
}

export { greetRpc, notesSearchRpc };
