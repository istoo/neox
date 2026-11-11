import { describe, expect, it } from "vitest";
import { LoopGuard, loopErrorEvent, loopTripMessage } from "./loop-guard.js";

const CYCLE = [
  "Now.",
  "Writing.",
  "Go.",
  "Let me write.",
  "OK.",
  "Here.",
  "Produce.",
  "Now.",
  "Writing.",
  "Final.",
  "Go.",
  "Let me write.",
  "OK.",
  "Producing.",
];

function chunk(field: string, text: string): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { [field]: text } }],
  })}\n\n`;
}

function loopText(count: number): string {
  let text = "";
  for (let index = 0; index < count; index += 1) {
    text += `${CYCLE[index % CYCLE.length]}\n\n`;
  }
  return text;
}

describe("a reply stuck in a loop", () => {
  it("finds the reporter's loop in its reasoning", () => {
    const guard = new LoopGuard();
    const text = loopText(300);
    let trip = null;
    for (let at = 0; at < text.length; at += 5) {
      trip = guard.feed(chunk("reasoning_content", text.slice(at, at + 5)));
      if (trip !== null) {
        break;
      }
    }
    expect(trip).not.toBeNull();
    expect(trip?.reasoning).toBe(true);
    expect(trip?.window).toBe(256);
    expect(
      loopTripMessage(trip ?? { reasoning: true, units: [], window: 256, runOn: false }),
    ).toContain("Neox ended this reply");
  });

  it("finds it in the reply's text too", () => {
    const guard = new LoopGuard();
    const trip = guard.feed(chunk("content", loopText(300)));
    expect(trip?.reasoning).toBe(false);
    expect(trip?.units.length).toBeLessThanOrEqual(24);
  });

  it("leaves ordinary writing alone", () => {
    const guard = new LoopGuard();
    const prose = Array.from(
      { length: 400 },
      (_, index) =>
        `Step ${index}: check the loader, then the parser, and write the case for item ${index}.\n`,
    ).join("");
    expect(guard.feed(chunk("content", prose))).toBeNull();
  });

  it("finds a run with no break in it", () => {
    const guard = new LoopGuard();
    const trip = guard.feed(chunk("content", "mcp ".repeat(3000)));
    expect(trip?.runOn).toBe(true);
  });

  it("writes the error in the client's protocol", () => {
    expect(loopErrorEvent("anthropic", "stop")).toContain("event: error");
    expect(loopErrorEvent("openai", "stop")).toContain('"type":"server_error"');
    expect(loopErrorEvent("openai-responses", "stop")).toContain("response.failed");
    expect(loopErrorEvent("gemini", "stop")).toContain('"status":"INTERNAL"');
  });
});
