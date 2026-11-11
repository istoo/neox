// Synara voice transcription backed by the Neox dictation stream.
//
// Synara hands over one base64 WAV clip per request; Neox records in a streaming dictation
// session whose chunks are raw PCM16 mono. The bridge parses the WAV container, extracts its PCM
// payload, and drives start/chunk/finish on the daemon's dictation stream. The request's
// `provider`/`providerInstanceId` select an agent provider in Synara; Neox dictation uses the
// daemon's configured speech-to-text provider, so they do not participate here.
import { randomUUID } from "node:crypto";

import {
  type ServerRealtimeVoiceAudioInput,
  type ServerRealtimeVoiceAudioPlayedInput,
  type ServerRealtimeVoiceCapabilitiesResult,
  type ServerRealtimeVoiceEvent,
  type ServerStartRealtimeVoiceInput,
  type ServerStartRealtimeVoiceResult,
  type ServerStopRealtimeVoiceResult,
  type ServerVoicePrewarmResult,
  type ServerVoiceTranscriptionInput,
  type ServerVoiceTranscriptionResult,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import { bridgeError, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

/** 16-bit mono PCM is what the daemon's resampler consumes. */
const DICTATION_FORMAT_PREFIX = "audio/pcm";
const CHUNK_BYTES = 64 * 1024;

function fromPromise<A>(_method: string, run: () => Promise<A>): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => rpcError(cause),
  });
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

export interface DictationAudio {
  readonly pcm: Uint8Array;
  readonly sampleRateHz: number;
}

/**
 * Extracts the PCM payload from a RIFF/WAVE clip. Only the encoding the browser recorder emits
 * (PCM, mono, 16-bit) is accepted; anything else would be fed to the speech model as noise.
 */
export function extractWavPcm(bytes: Uint8Array): DictationAudio {
  if (
    bytes.byteLength < 44 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WAVE"
  ) {
    throw bridgeError("voice.invalid-clip", "Audio must be a RIFF/WAVE clip.");
  }

  let sampleRateHz: number | null = null;
  let channels: number | null = null;
  let bitsPerSample: number | null = null;
  let audioFormat: number | null = null;
  let data: Uint8Array | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = readUint32(bytes, offset + 4);
    const body = offset + 8;
    if (body + size > bytes.byteLength) break;
    if (id === "fmt " && size >= 16) {
      audioFormat = readUint16(bytes, body);
      channels = readUint16(bytes, body + 2);
      sampleRateHz = readUint32(bytes, body + 4);
      bitsPerSample = readUint16(bytes, body + 14);
    } else if (id === "data") {
      data = bytes.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }

  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
    throw bridgeError("voice.wrong-format", "Audio must be 16-bit mono PCM WAV.");
  }
  if (!sampleRateHz || sampleRateHz <= 0) {
    throw bridgeError("voice.invalid-sample-rate", "Audio has no valid sample rate.");
  }
  if (!data || data.byteLength === 0) {
    throw bridgeError("voice.no-samples", "Audio clip contains no samples.");
  }
  // A truncated sample cannot be encoded; the resampler needs whole 16-bit frames.
  const evenLength = data.byteLength - (data.byteLength % 2);
  return { pcm: data.subarray(0, evenLength), sampleRateHz };
}

async function transcribe(
  model: BridgeModel,
  input: ServerVoiceTranscriptionInput,
): Promise<ServerVoiceTranscriptionResult> {
  const audio = extractWavPcm(new Uint8Array(Buffer.from(input.audioBase64, "base64")));
  const client = model.client;
  const dictationId = randomUUID();
  const format = `${DICTATION_FORMAT_PREFIX};rate=${audio.sampleRateHz};bits=16`;

  await client.startDictationStream(dictationId, format);
  try {
    let seq = 0;
    for (let offset = 0; offset < audio.pcm.byteLength; offset += CHUNK_BYTES) {
      const chunk = audio.pcm.subarray(
        offset,
        Math.min(offset + CHUNK_BYTES, audio.pcm.byteLength),
      );
      client.sendDictationStreamChunk(
        dictationId,
        seq,
        Buffer.from(chunk).toString("base64"),
        format,
      );
      seq += 1;
    }
    const result = await client.finishDictationStream(dictationId, seq - 1);
    const text = result.text.trim();
    if (!text) {
      throw bridgeError("voice.no-speech", "No speech was detected in the recording.");
    }
    return { text };
  } catch (cause) {
    // A failed finish leaves the daemon stream allocated; cancelling is safe whether or not the
    // finish already tore it down.
    try {
      client.cancelDictationStream(dictationId);
    } catch {
      // Best effort.
    }
    throw cause;
  }
}

/**
 * The daemon advertises speech readiness on `server_info.capabilities.voice`. An older host
 * omits it; returning null leaves the decision to the start call, which reports the same reason
 * as an error instead of hiding the control.
 */
export function realtimeVoiceCapabilities(
  client: BridgeModel["client"],
): ServerRealtimeVoiceCapabilitiesResult {
  const voice = client.getLastServerInfoMessage()?.capabilities?.voice;
  return {
    dictation: voice?.dictation ?? null,
    voice: voice?.voice ?? null,
  };
}

interface DaemonAudioOutput {
  audio: string;
  format: string;
  id: string;
  isVoiceMode: boolean;
  groupId?: string | undefined;
  chunkIndex?: number | undefined;
  isLastChunk?: boolean | undefined;
}

export function realtimeVoiceEventFromAudio(payload: DaemonAudioOutput): ServerRealtimeVoiceEvent {
  return {
    kind: "audio",
    audio: payload.audio,
    format: payload.format,
    id: payload.id,
    isVoiceMode: payload.isVoiceMode,
    ...(payload.groupId ? { groupId: payload.groupId } : {}),
    ...(payload.chunkIndex !== undefined ? { chunkIndex: payload.chunkIndex } : {}),
    ...(payload.isLastChunk !== undefined ? { isLastChunk: payload.isLastChunk } : {}),
  };
}

export function realtimeVoiceEventFromSpeech(isSpeaking: boolean): ServerRealtimeVoiceEvent {
  return { kind: "speech", isSpeaking };
}

export function realtimeVoiceEventFromTranscript(
  text: string,
  requestId: string,
): ServerRealtimeVoiceEvent {
  return { kind: "transcript", text, requestId };
}

/**
 * Bridges the daemon's session messages into one stream per subscriber. Audio chunks carry the
 * daemon's own ids so the client can acknowledge playback and let the host pace TTS.
 */
export function realtimeVoiceEvents(
  client: BridgeModel["client"],
): Stream.Stream<ServerRealtimeVoiceEvent> {
  return Stream.callback<ServerRealtimeVoiceEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => [
        client.on("audio_output", (message) => {
          Queue.offerUnsafe(queue, realtimeVoiceEventFromAudio(message.payload));
        }),
        client.on("voice_input_state", (message) => {
          Queue.offerUnsafe(queue, realtimeVoiceEventFromSpeech(message.payload.isSpeaking));
        }),
        client.on("transcription_result", (message) => {
          Queue.offerUnsafe(
            queue,
            realtimeVoiceEventFromTranscript(message.payload.text, message.payload.requestId),
          );
        }),
      ]),
      (unsubscribers) =>
        Effect.sync(() => {
          for (const unsubscribe of unsubscribers) unsubscribe();
        }),
    ),
  );
}

export function makeVoiceHandlers(model: BridgeModel): Record<string, AnyHandler> {
  return {
    [WS_METHODS.serverVoiceCapabilities]: () =>
      Effect.sync(() => realtimeVoiceCapabilities(model.client)),
    [WS_METHODS.serverStartRealtimeVoice]: (payload) =>
      fromPromise("server.startRealtimeVoice", async () => {
        const input = payload as ServerStartRealtimeVoiceInput;
        const result = await model.client.setVoiceMode(true, input.agentId);
        return {
          enabled: result.enabled,
          agentId: result.agentId ?? input.agentId,
        } satisfies ServerStartRealtimeVoiceResult;
      }),
    [WS_METHODS.serverStopRealtimeVoice]: () =>
      fromPromise("server.stopRealtimeVoice", async () => {
        const result = await model.client.setVoiceMode(false);
        return { enabled: result.enabled } satisfies ServerStopRealtimeVoiceResult;
      }),
    [WS_METHODS.serverRealtimeVoiceAudio]: (payload) =>
      fromPromise("server.realtimeVoiceAudio", async () => {
        const input = payload as ServerRealtimeVoiceAudioInput;
        await model.client.sendVoiceAudioChunk(input.audioBase64, input.format, false);
      }),
    [WS_METHODS.serverRealtimeVoiceAudioPlayed]: (payload) =>
      fromPromise("server.realtimeVoiceAudioPlayed", async () => {
        const input = payload as ServerRealtimeVoiceAudioPlayedInput;
        await model.client.audioPlayed(input.id);
      }),
    [WS_METHODS.subscribeServerRealtimeVoice]: () => realtimeVoiceEvents(model.client),
    // The first dictation stream starts the speech provider on demand; Neox has no separate
    // prewarm route, so report readiness without doing work.
    [WS_METHODS.serverPrewarmVoice]: () =>
      Effect.succeed({ ready: true } satisfies ServerVoicePrewarmResult),
    [WS_METHODS.serverTranscribeVoice]: (payload) =>
      fromPromise("server.transcribeVoice", () =>
        transcribe(model, payload as ServerVoiceTranscriptionInput),
      ),
  };
}
