import {
  ServerRealtimeVoiceCapabilitiesResult,
  ServerStartRealtimeVoiceResult,
  ServerStopRealtimeVoiceResult,
  ServerVoicePrewarmResult,
  ServerVoiceTranscriptionResult,
  WS_METHODS,
} from "@synara/contracts";
import { Effect, Fiber, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import {
  extractWavPcm,
  makeVoiceHandlers,
  realtimeVoiceEventFromAudio,
  realtimeVoiceEventFromSpeech,
  realtimeVoiceEventFromTranscript,
} from "./voiceRpc.ts";
import type { AnyHandler } from "./stubs.ts";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function makeWav(samples: Int16Array, sampleRateHz = 24_000): Uint8Array {
  const dataLength = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataLength, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataLength, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  return new Uint8Array(bytes);
}

function makeHarness(
  options: { text?: string; serverInfo?: unknown; setVoiceModeError?: Error } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const messageHandlers = new Map<string, Set<(message: unknown) => void>>();
  const client = {
    getLastServerInfoMessage: () => options.serverInfo ?? null,
    setVoiceMode: async (enabled: boolean, agentId?: string) => {
      calls.push(["setVoiceMode", { enabled, agentId }]);
      if (options.setVoiceModeError) throw options.setVoiceModeError;
      return {
        requestId: "voice-request",
        enabled,
        agentId: enabled ? (agentId ?? null) : null,
        accepted: true,
        error: null,
      };
    },
    sendVoiceAudioChunk: async (audio: string, format: string, isLast: boolean) => {
      calls.push([
        "sendVoiceAudioChunk",
        { bytes: Buffer.from(audio, "base64").byteLength, format, isLast },
      ]);
    },
    audioPlayed: async (id: string) => {
      calls.push(["audioPlayed", id]);
    },
    on: (type: string, handler: (message: unknown) => void) => {
      const handlers = messageHandlers.get(type) ?? new Set();
      handlers.add(handler);
      messageHandlers.set(type, handlers);
      return () => handlers.delete(handler);
    },
    startDictationStream: async (dictationId: string, format: string) => {
      calls.push(["start", { dictationId, format }]);
    },
    sendDictationStreamChunk: (dictationId: string, seq: number, audio: string, format: string) => {
      calls.push([
        "chunk",
        { dictationId, seq, bytes: Buffer.from(audio, "base64").byteLength, format },
      ]);
    },
    finishDictationStream: async (dictationId: string, finalSeq: number) => {
      calls.push(["finish", { dictationId, finalSeq }]);
      return { dictationId, text: options.text ?? "  hello world  " };
    },
    cancelDictationStream: (dictationId: string) => {
      calls.push(["cancel", dictationId]);
    },
  };
  const model = { client } as unknown as BridgeModel;
  return { handlers: makeVoiceHandlers(model), calls, messageHandlers };
}

describe("voiceRpc WAV parsing", () => {
  it("extracts PCM and the sample rate", () => {
    const wav = makeWav(Int16Array.from([0, 100, -100]), 16_000);
    const audio = extractWavPcm(wav);
    expect(audio.sampleRateHz).toBe(16_000);
    expect(audio.pcm.byteLength).toBe(6);
  });

  it("refuses audio that is not 16-bit mono PCM WAV", () => {
    expect(() => extractWavPcm(new Uint8Array([1, 2, 3]))).toThrow(/RIFF\/WAVE/);
  });
});

describe("voiceRpc handlers", () => {
  it("streams the clip through dictation and returns the transcript", async () => {
    const { handlers, calls } = makeHarness();
    const audioBase64 = Buffer.from(makeWav(Int16Array.from([0, 1, 2, 3]))).toString("base64");
    const result = await run<ServerVoiceTranscriptionResult>(
      handlers[WS_METHODS.serverTranscribeVoice],
      {
        provider: "codex",
        cwd: "/repo",
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 100,
        audioBase64,
      },
    );
    const encoded = encode(ServerVoiceTranscriptionResult, result);
    expect(encoded).toEqual({ text: "hello world" });
    expect(calls[0]?.[0]).toBe("start");
    expect(calls[0]?.[1]).toMatchObject({ format: "audio/pcm;rate=24000;bits=16" });
    expect(calls[1]?.[1]).toMatchObject({ seq: 0, bytes: 8 });
    expect(calls[2]?.[1]).toMatchObject({ finalSeq: 0 });
  });

  it("reports an empty transcript as an error", async () => {
    const { handlers, calls } = makeHarness({ text: "   " });
    const audioBase64 = Buffer.from(makeWav(Int16Array.from([0, 1]))).toString("base64");
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.serverTranscribeVoice]!(
          {
            provider: "codex",
            cwd: "/repo",
            mimeType: "audio/wav",
            sampleRateHz: 24_000,
            durationMs: 10,
            audioBase64,
          },
          {},
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("No speech") });
    expect(calls.map(([name]) => name)).toEqual(["start", "chunk", "finish", "cancel"]);
  });

  it("answers prewarm without a daemon call", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<ServerVoicePrewarmResult>(handlers[WS_METHODS.serverPrewarmVoice], {
      provider: "codex",
      cwd: "/repo",
    });
    expect(encode(ServerVoicePrewarmResult, result)).toEqual({ ready: true });
    expect(calls).toEqual([]);
  });
});

describe("voiceRpc realtime voice", () => {
  it("reports daemon speech readiness and treats a missing capability as unknown", async () => {
    const withCaps = makeHarness({
      serverInfo: {
        capabilities: {
          voice: {
            dictation: { enabled: true, reason: "" },
            voice: { enabled: false, reason: "Install a speech model." },
          },
        },
      },
    });
    const result = await run<ServerRealtimeVoiceCapabilitiesResult>(
      withCaps.handlers[WS_METHODS.serverVoiceCapabilities],
      {},
    );
    expect(encode(ServerRealtimeVoiceCapabilitiesResult, result)).toEqual({
      dictation: { enabled: true, reason: "" },
      voice: { enabled: false, reason: "Install a speech model." },
    });

    const withoutCaps = makeHarness();
    const unknown = await run<ServerRealtimeVoiceCapabilitiesResult>(
      withoutCaps.handlers[WS_METHODS.serverVoiceCapabilities],
      {},
    );
    expect(encode(ServerRealtimeVoiceCapabilitiesResult, unknown)).toEqual({
      dictation: null,
      voice: null,
    });
  });

  it("enables voice for the agent, forwards PCM chunks, and acknowledges playback", async () => {
    const { handlers, calls } = makeHarness();
    const started = await run<ServerStartRealtimeVoiceResult>(
      handlers[WS_METHODS.serverStartRealtimeVoice],
      { agentId: "agent-1" },
    );
    expect(encode(ServerStartRealtimeVoiceResult, started)).toEqual({
      enabled: true,
      agentId: "agent-1",
    });

    const pcm = Buffer.from(Int16Array.from([1, 2, 3]).buffer).toString("base64");
    await run<unknown>(handlers[WS_METHODS.serverRealtimeVoiceAudio], {
      audioBase64: pcm,
      format: "audio/pcm;rate=16000;bits=16",
    });
    await run<unknown>(handlers[WS_METHODS.serverRealtimeVoiceAudioPlayed], { id: "chunk-1" });

    const stopped = await run<ServerStopRealtimeVoiceResult>(
      handlers[WS_METHODS.serverStopRealtimeVoice],
      {},
    );
    expect(encode(ServerStopRealtimeVoiceResult, stopped)).toEqual({ enabled: false });

    expect(calls).toEqual([
      ["setVoiceMode", { enabled: true, agentId: "agent-1" }],
      ["sendVoiceAudioChunk", { bytes: 6, format: "audio/pcm;rate=16000;bits=16", isLast: false }],
      ["audioPlayed", "chunk-1"],
      ["setVoiceMode", { enabled: false, agentId: undefined }],
    ]);
  });

  it("surfaces a daemon refusal as an RPC error", async () => {
    const { handlers } = makeHarness({
      setVoiceModeError: new Error("Voice mode is disabled (voice_disabled)"),
    });
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.serverStartRealtimeVoice]!({ agentId: "agent-1" }, {}) as Effect.Effect<
          unknown,
          never
        >,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Voice mode is disabled"),
    });
  });

  it("bridges daemon session messages into the subscription stream", async () => {
    const { handlers, messageHandlers } = makeHarness();
    const stream = handlers[WS_METHODS.subscribeServerRealtimeVoice]!(
      {},
      {},
    ) as Stream.Stream<unknown>;
    const events: unknown[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(stream, (event) => Effect.sync(() => events.push(event))),
        );
        yield* Effect.sleep(5);
        for (const handler of messageHandlers.get("voice_input_state") ?? []) {
          handler({ type: "voice_input_state", payload: { isSpeaking: true } });
        }
        for (const handler of messageHandlers.get("transcription_result") ?? []) {
          handler({ type: "transcription_result", payload: { text: "hello", requestId: "r1" } });
        }
        yield* Effect.sleep(5);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(events).toEqual([
      { kind: "speech", isSpeaking: true },
      { kind: "transcript", text: "hello", requestId: "r1" },
    ]);
    // Releasing the stream detaches the daemon listeners.
    expect(messageHandlers.get("voice_input_state")?.size ?? 0).toBe(0);
    expect(messageHandlers.get("transcription_result")?.size ?? 0).toBe(0);
  });

  it("maps daemon messages to stream events without losing playback metadata", () => {
    expect(
      realtimeVoiceEventFromAudio({
        audio: "AAA=",
        format: "mp3",
        id: "chunk-1",
        isVoiceMode: true,
        groupId: "reply-1",
        chunkIndex: 2,
        isLastChunk: true,
      }),
    ).toEqual({
      kind: "audio",
      audio: "AAA=",
      format: "mp3",
      id: "chunk-1",
      isVoiceMode: true,
      groupId: "reply-1",
      chunkIndex: 2,
      isLastChunk: true,
    });
    expect(realtimeVoiceEventFromSpeech(true)).toEqual({ kind: "speech", isSpeaking: true });
    expect(realtimeVoiceEventFromTranscript("hello", "request-1")).toEqual({
      kind: "transcript",
      text: "hello",
      requestId: "request-1",
    });
  });
});
