import type { IrEvent, IrRequest, IrResponse } from "./ir.js";
import type { GatewayProtocol } from "./upstream.js";

export interface StreamDecoder {
  /** Consumes a raw upstream chunk and returns the events it completed. */
  push(chunk: string): IrEvent[];
  flush(): IrEvent[];
}

export interface StreamEncoder {
  start(): string;
  push(event: IrEvent): string;
  end(): string;
  /** The response id the encoder named the reply with, when it names one. */
  replyId?(): string;
}

/** One wire protocol: Anthropic Messages or OpenAI Chat Completions. */
export interface ProtocolCodec {
  protocol: GatewayProtocol;
  parseRequest(body: Record<string, unknown>): IrRequest;
  buildRequestBody(request: IrRequest, model: string): Record<string, unknown>;
  parseResponse(body: Record<string, unknown>): IrResponse;
  buildResponseBody(response: IrResponse, requestedModel: string): Record<string, unknown>;
  createStreamDecoder(): StreamDecoder;
  createStreamEncoder(requestedModel: string): StreamEncoder;
}
