import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  describeRealtimeVoiceError,
  floatToPcm16,
  isPcmFormat,
  pcm16Base64FromFloat32,
  pcmSampleRateFromFormat,
  resampleLinear,
} from "./realtimeVoice";

describe("realtimeVoice base64", () => {
  it("round-trips bytes without a Buffer dependency", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe("realtimeVoice PCM encoding", () => {
  it("writes little-endian int16 and clips out-of-range samples", () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2]));
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
    expect(view.getInt16(6, true)).toBe(0x7fff);
    expect(view.getInt16(8, true)).toBe(-0x8000);
  });

  it("resamples a 48 kHz block to 16 kHz and encodes a 100 ms chunk", () => {
    const input = new Float32Array(4_800);
    for (let index = 0; index < input.length; index += 1) {
      input[index] = Math.sin((index / 48_000) * 2 * Math.PI * 440);
    }
    const resampled = resampleLinear(input, 48_000, 16_000);
    expect(resampled.length).toBe(1_600);
    const encoded = pcm16Base64FromFloat32(input, 48_000);
    expect(base64ToBytes(encoded).byteLength).toBe(3_200);
  });
});

describe("realtimeVoice TTS format parsing", () => {
  it("reads an explicit rate and falls back to 24 kHz for bare pcm", () => {
    expect(pcmSampleRateFromFormat("audio/pcm;rate=16000;bits=16")).toBe(16_000);
    expect(pcmSampleRateFromFormat("pcm")).toBe(24_000);
    expect(pcmSampleRateFromFormat("audio/mpeg")).toBe(24_000);
  });

  it("recognises PCM containers and leaves encoded audio to decodeAudioData", () => {
    expect(isPcmFormat("audio/pcm;rate=24000;bits=16")).toBe(true);
    expect(isPcmFormat("pcm")).toBe(true);
    expect(isPcmFormat("mp3")).toBe(false);
    expect(isPcmFormat("audio/mpeg")).toBe(false);
  });
});

describe("realtimeVoice errors", () => {
  it("turns a denied microphone into actionable copy", () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    expect(describeRealtimeVoiceError(denied)).toContain("Allow microphone access");
  });
});
