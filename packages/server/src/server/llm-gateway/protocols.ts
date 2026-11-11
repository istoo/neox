import { anthropicCodec } from "./anthropic-codec.js";
import type { ProtocolCodec } from "./codec.js";
import { geminiCodec } from "./gemini-codec.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";
import type { GatewayProtocol } from "./upstream.js";

const CODECS: Record<GatewayProtocol, ProtocolCodec> = {
  anthropic: anthropicCodec,
  openai: openAiChatCodec,
  "openai-responses": openAiResponsesCodec,
  gemini: geminiCodec,
};

export function codecFor(protocol: GatewayProtocol): ProtocolCodec {
  return CODECS[protocol];
}
