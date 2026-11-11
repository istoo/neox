// FILE: realtimeVoice.ts
// Purpose: Browser runtime for Neox realtime voice: microphone capture, PCM upload, playback,
//          barge-in, and the composer voice state machine.
// Layer: Web client runtime
// Depends on: the bridge's realtime voice RPCs (via NativeApi), Web Audio, and getUserMedia.

import { t } from "~/i18n";
import { readNativeApi } from "../nativeApi";

/** The daemon's turn detector and STT pipeline consume 16 kHz mono PCM16. */
export const REALTIME_VOICE_SAMPLE_RATE = 16_000;
export const REALTIME_VOICE_FORMAT = `audio/pcm;rate=${REALTIME_VOICE_SAMPLE_RATE};bits=16`;
const CHUNK_DURATION_SECONDS = 0.1;
const DISPLAY_VOLUME_INTERVAL_MS = 60;
const MAX_CONSECUTIVE_SEND_FAILURES = 5;
/** Daemon TTS emits bare `pcm` at this rate when the format carries no parameter. */
const DEFAULT_TTS_PCM_SAMPLE_RATE = 24_000;

export type RealtimeVoicePhase =
  | "idle"
  | "starting"
  | "listening"
  | "waiting"
  | "speaking"
  | "stopping";

export interface RealtimeVoiceSnapshot {
  phase: RealtimeVoicePhase;
  agentId: string | null;
  muted: boolean;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  volume: number;
  error: string | null;
}

type RealtimeVoiceApi = NonNullable<
  NonNullable<ReturnType<typeof readNativeApi>>["server"]["realtimeVoice"]
>;

interface QueuedAudio {
  id: string;
  audio: string;
  format: string;
}

const INITIAL_SNAPSHOT: RealtimeVoiceSnapshot = {
  phase: "idle",
  agentId: null,
  muted: false,
  isUserSpeaking: false,
  isAssistantSpeaking: false,
  volume: 0,
  error: null,
};

function patch(
  snapshot: RealtimeVoiceSnapshot,
  update: Partial<RealtimeVoiceSnapshot>,
): RealtimeVoiceSnapshot {
  return { ...snapshot, ...update };
}

/** base64 → bytes without Buffer, for both capture and daemon audio. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/** Linear resampling is enough for speech: the daemon's VAD tolerates the slight band limit. */
export function resampleLinear(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate || samples.length === 0) return samples;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const lower = Math.min(samples.length - 1, Math.floor(position));
    const upper = Math.min(samples.length - 1, lower + 1);
    const fraction = position - lower;
    output[index] = (samples[lower] ?? 0) * (1 - fraction) + (samples[upper] ?? 0) * fraction;
  }
  return output;
}

/** Float samples → little-endian PCM16 bytes, clipped to avoid integer wrap distortion. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

/** One capture chunk: resample to the daemon rate, encode PCM16, then base64. */
export function pcm16Base64FromFloat32(
  samples: Float32Array,
  sourceRate: number,
  targetRate = REALTIME_VOICE_SAMPLE_RATE,
): string {
  return bytesToBase64(floatToPcm16(resampleLinear(samples, sourceRate, targetRate)));
}

/** Reads the sample rate out of `audio/pcm;rate=24000;bits=16`, falling back to bare `pcm`. */
export function pcmSampleRateFromFormat(format: string): number {
  const match = /(?:^|;)rate=(\d+)/i.exec(format);
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TTS_PCM_SAMPLE_RATE;
}

export function isPcmFormat(format: string): boolean {
  return format.trim().toLowerCase().startsWith("audio/pcm") || format.trim() === "pcm";
}

/** User-facing copy for the common permission and device failures. */
export function describeRealtimeVoiceError(error: unknown): string {
  const name =
    error !== null && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("chat:realtimeVoiceMicDenied");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return t("chat:realtimeVoiceNoMicrophone");
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return t("chat:microphoneBusy");
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return t("chat:realtimeVoiceStartFailed");
}

/** Buffers capture blocks and emits whole 100 ms chunks at the daemon rate. */
class CaptureChunker {
  private pending = new Float32Array(0);

  constructor(private readonly inputRate: number) {}

  push(block: Float32Array): string[] {
    const combined = new Float32Array(this.pending.length + block.length);
    combined.set(this.pending, 0);
    combined.set(block, this.pending.length);
    const chunkSamples = Math.max(1, Math.round(this.inputRate * CHUNK_DURATION_SECONDS));
    const chunks: string[] = [];
    let offset = 0;
    while (combined.length - offset >= chunkSamples) {
      const slice = combined.subarray(offset, offset + chunkSamples);
      chunks.push(pcm16Base64FromFloat32(slice, this.inputRate));
      offset += chunkSamples;
    }
    this.pending = combined.slice(offset);
    return chunks;
  }

  reset(): void {
    this.pending = new Float32Array(0);
  }
}

interface CaptureState {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunker: CaptureChunker;
}

interface PlaybackState {
  context: AudioContext;
  queue: QueuedAudio[];
  playing: boolean;
  activeSource: AudioBufferSourceNode | null;
  generation: number;
}

export class RealtimeVoiceRuntime {
  private snapshot: RealtimeVoiceSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private api: RealtimeVoiceApi | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private capture: CaptureState | null = null;
  private playback: PlaybackState | null = null;
  private voiceEnabled = false;
  private consecutiveSendFailures = 0;
  private lastVolumePublish = 0;
  /** Cancels a start that lost the race with a stop or a navigation. */
  private generation = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RealtimeVoiceSnapshot => this.snapshot;

  private patch(update: Partial<RealtimeVoiceSnapshot>): void {
    const next = patch(this.snapshot, update);
    const changed = (Object.keys(next) as Array<keyof RealtimeVoiceSnapshot>).some(
      (key) => next[key] !== this.snapshot[key],
    );
    if (!changed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  isActive(): boolean {
    return this.snapshot.phase !== "idle" && this.snapshot.phase !== "stopping";
  }

  isActiveFor(agentId: string): boolean {
    return this.isActive() && this.snapshot.agentId === agentId;
  }

  clearError(): void {
    if (this.snapshot.error !== null) this.patch({ error: null });
  }

  toggleMute(): void {
    if (!this.isActive()) return;
    const muted = !this.snapshot.muted;
    this.patch({ muted, volume: muted ? 0 : this.snapshot.volume });
  }

  async start(agentId: string): Promise<void> {
    if (this.snapshot.phase !== "idle") return;
    const api = readNativeApi()?.server.realtimeVoice;
    if (!api) throw new Error("Realtime voice is unavailable in this build.");
    const generation = ++this.generation;
    this.api = api;
    this.patch({ phase: "starting", agentId, error: null, muted: false });

    try {
      const capabilities = await api.capabilities();
      if (generation !== this.generation) return;
      if (capabilities.voice && (!capabilities.voice.enabled || capabilities.voice.reason.trim())) {
        throw new Error(
          capabilities.voice.reason.trim() || "Realtime voice is disabled on this host.",
        );
      }

      // Subscribe before enabling: the daemon can start emitting speech state immediately.
      this.unsubscribeEvents = api.onEvent((event) => this.handleEvent(event));
      // Enabling first means a host with voice mode switched off fails before the browser
      // asks for the microphone, matching the RN client's order.
      await api.start({ agentId });
      if (generation !== this.generation) {
        await api.stop().catch(() => undefined);
        return;
      }
      this.voiceEnabled = true;
      await this.startCapture();
      if (generation !== this.generation) {
        this.stopCapture();
        this.voiceEnabled = false;
        await api.stop().catch(() => undefined);
        return;
      }
      // Create the playback context inside the click gesture so autoplay policy allows it.
      void this.ensurePlayback()
        ?.context.resume()
        .catch(() => undefined);
      this.patch({ phase: "listening", isUserSpeaking: false, isAssistantSpeaking: false });
    } catch (error) {
      if (generation !== this.generation) return;
      const shouldDisable = this.voiceEnabled;
      this.voiceEnabled = false;
      await this.teardown();
      if (shouldDisable) {
        await api.stop().catch(() => undefined);
      }
      this.api = null;
      // A failed start must release the composer: leaving "starting" would strand the bar.
      this.patch({ ...INITIAL_SNAPSHOT });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.snapshot.phase === "idle" || this.snapshot.phase === "stopping") return;
    this.generation += 1;
    this.patch({ phase: "stopping" });
    const shouldDisable = this.voiceEnabled;
    this.voiceEnabled = false;
    await this.teardown();
    if (shouldDisable) {
      await this.api?.stop().catch(() => undefined);
    }
    this.api = null;
    this.patch({ ...INITIAL_SNAPSHOT });
  }

  private async teardown(): Promise<void> {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.stopCapture();
    this.stopPlayback();
  }

  private async startCapture(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone recording is unavailable in this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: REALTIME_VOICE_SAMPLE_RATE });
    } catch {
      context = new AudioContext();
    }
    await context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universally available and matches the existing
    // composer recorder; AudioWorklet would need a separate bundler-emitted module.
    const processor = context.createScriptProcessor(2048, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    const capture: CaptureState = {
      stream,
      context,
      source,
      processor,
      silentGain,
      chunker: new CaptureChunker(context.sampleRate),
    };
    processor.onaudioprocess = (event) => this.handleCaptureBlock(event);
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    this.capture = capture;
  }

  private handleCaptureBlock(event: AudioProcessingEvent): void {
    const capture = this.capture;
    if (!capture) return;
    const frame = event.inputBuffer.getChannelData(0);
    let sumOfSquares = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const sample = frame[index] ?? 0;
      sumOfSquares += sample * sample;
    }
    const now = performance.now();
    if (now - this.lastVolumePublish >= DISPLAY_VOLUME_INTERVAL_MS) {
      this.lastVolumePublish = now;
      const volume = this.snapshot.muted
        ? 0
        : Math.min(1, Math.sqrt(sumOfSquares / Math.max(1, frame.length)) * 4);
      this.patch({ volume: Number(volume.toFixed(3)) });
    }

    if (this.snapshot.muted || !this.voiceEnabled) return;
    for (const chunk of capture.chunker.push(frame)) {
      void this.sendChunk(chunk);
    }
  }

  private async sendChunk(audioBase64: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      await api.appendAudio({ audioBase64, format: REALTIME_VOICE_FORMAT });
      this.consecutiveSendFailures = 0;
    } catch (error) {
      this.consecutiveSendFailures += 1;
      if (this.consecutiveSendFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        this.fail(describeRealtimeVoiceError(error));
      }
    }
  }

  private stopCapture(): void {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return;
    capture.processor.onaudioprocess = null;
    capture.source.disconnect();
    capture.processor.disconnect();
    capture.silentGain.disconnect();
    capture.stream.getTracks().forEach((track) => track.stop());
    void capture.context.close().catch(() => undefined);
    capture.chunker.reset();
  }

  private ensurePlayback(): PlaybackState | null {
    if (this.playback) return this.playback;
    try {
      this.playback = {
        context: new AudioContext(),
        queue: [],
        playing: false,
        activeSource: null,
        generation: 0,
      };
      return this.playback;
    } catch {
      return null;
    }
  }

  private stopPlayback(): void {
    const playback = this.playback;
    this.playback = null;
    if (!playback) return;
    playback.generation += 1;
    playback.queue = [];
    try {
      playback.activeSource?.stop();
    } catch {
      // Already stopped.
    }
    playback.activeSource = null;
    void playback.context.close().catch(() => undefined);
  }

  private handleEvent(event: {
    kind: string;
    isSpeaking?: boolean;
    text?: string;
    audio?: string;
    format?: string;
    id?: string;
    isVoiceMode?: boolean;
    message?: string;
  }): void {
    if (event.kind === "speech") {
      const isSpeaking = event.isSpeaking === true;
      if (isSpeaking) this.interruptPlayback();
      this.patch({ isUserSpeaking: isSpeaking });
      return;
    }
    if (event.kind === "transcript") {
      const text = (event.text ?? "").trim();
      // A blank transcript means the detector discarded non-speech; stay listening.
      this.patch({ phase: text.length > 0 ? "waiting" : "listening" });
      return;
    }
    if (event.kind === "error") {
      this.fail(event.message?.trim() || "Realtime voice stopped unexpectedly.");
      return;
    }
    if (event.kind !== "audio") return;
    if (event.isVoiceMode !== true) return;
    if (!event.audio || !event.format || !event.id) return;
    this.enqueueAudio({ id: event.id, audio: event.audio, format: event.format });
  }

  private enqueueAudio(chunk: QueuedAudio): void {
    const playback = this.ensurePlayback();
    if (!playback) return;
    playback.queue.push(chunk);
    void this.drainPlayback(playback);
  }

  private async drainPlayback(playback: PlaybackState): Promise<void> {
    if (playback.playing) return;
    playback.playing = true;
    const generation = playback.generation;
    while (playback.queue.length > 0) {
      if (this.playback !== playback || generation !== playback.generation) return;
      const chunk = playback.queue.shift();
      if (!chunk) break;
      const buffer = await this.decodeAudio(playback.context, chunk);
      if (this.playback !== playback || generation !== playback.generation) return;
      if (!buffer) continue;
      this.patch({ phase: "speaking", isAssistantSpeaking: true });
      await this.playBuffer(playback, buffer);
      if (generation !== playback.generation) return;
      void this.api?.audioPlayed({ id: chunk.id }).catch(() => undefined);
    }
    if (this.playback !== playback || generation !== playback.generation) return;
    playback.playing = false;
    if (playback.queue.length > 0) {
      void this.drainPlayback(playback);
      return;
    }
    this.patch({ isAssistantSpeaking: false });
    if (this.snapshot.phase === "speaking") {
      this.patch({ phase: "listening" });
    }
  }

  private async decodeAudio(
    context: AudioContext,
    chunk: QueuedAudio,
  ): Promise<AudioBuffer | null> {
    const bytes = base64ToBytes(chunk.audio);
    if (isPcmFormat(chunk.format)) {
      const sampleRate = pcmSampleRateFromFormat(chunk.format);
      const sampleCount = Math.floor(bytes.length / 2);
      if (sampleCount === 0) return null;
      const buffer = context.createBuffer(1, sampleCount, sampleRate);
      const channel = buffer.getChannelData(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < sampleCount; index += 1) {
        channel[index] = view.getInt16(index * 2, true) / 0x8000;
      }
      return buffer;
    }
    try {
      const copy = bytes.slice().buffer;
      return await context.decodeAudioData(copy);
    } catch {
      return null;
    }
  }

  private playBuffer(playback: PlaybackState, buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const source = playback.context.createBufferSource();
      source.buffer = buffer;
      source.connect(playback.context.destination);
      playback.activeSource = source;
      source.addEventListener(
        "ended",
        () => {
          if (playback.activeSource === source) playback.activeSource = null;
          resolve();
        },
        { once: true },
      );
      try {
        source.start();
      } catch {
        resolve();
      }
    });
  }

  private interruptPlayback(): void {
    const playback = this.playback;
    if (!playback) return;
    playback.generation += 1;
    playback.queue = [];
    playback.playing = false;
    try {
      playback.activeSource?.stop();
    } catch {
      // Already stopped.
    }
    playback.activeSource = null;
    this.patch({ isAssistantSpeaking: false });
    if (this.snapshot.phase === "speaking") this.patch({ phase: "listening" });
  }

  private fail(message: string): void {
    this.generation += 1;
    const shouldDisable = this.voiceEnabled;
    this.voiceEnabled = false;
    this.patch({ error: message, phase: "stopping" });
    void this.teardown();
    if (shouldDisable) {
      void this.api?.stop().catch(() => undefined);
    }
    this.api = null;
    this.patch({ ...INITIAL_SNAPSHOT, error: message });
  }
}
