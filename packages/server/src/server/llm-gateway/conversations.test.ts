import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigStore } from "./config.js";
import { GatewayConversations } from "./conversations.js";

const roots: string[] = [];
const logger = pino({ level: "silent" });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  neolixHome: string;
  conversations: GatewayConversations;
  store: GatewayConfigStore;
}> {
  const neolixHome = await mkdtemp(path.join(tmpdir(), "neolix-gateway-conversations-"));
  roots.push(neolixHome);
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  return {
    neolixHome,
    store,
    conversations: new GatewayConversations({ neolixHome, configStore: store, logger }),
  };
}

class FakeResponse extends EventEmitter {
  public statusCode = 200;
  public readonly chunks: string[] = [];
  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  public end(chunk?: string): this {
    if (chunk !== undefined) {
      this.chunks.push(chunk);
    }
    this.emit("finish");
    return this;
  }
}

function fakeRequest(input: { body: Record<string, unknown>; session: string }): ExpressRequest {
  const headers = new Map([
    ["x-neolix-conversation", input.session],
    ["user-agent", "claude-cli/2"],
  ]);
  return {
    body: input.body,
    get: (name: string) => headers.get(name),
  } as unknown as ExpressRequest;
}

describe("GatewayConversations", () => {
  it("records only while the config says so, as parts the page can size", async () => {
    const { conversations, store } = await fixture();
    expect(conversations.isEnabled()).toBe(false);

    await conversations.setEnabled(true);
    expect(store.get().recording?.enabled).toBe(true);
    expect(conversations.isEnabled()).toBe(true);

    const response = new FakeResponse();
    conversations.capture(
      fakeRequest({
        session: "session-1",
        body: {
          model: "a/model",
          messages: [{ role: "user", content: "hello" }],
        },
      }),
      response as unknown as ExpressResponse,
      "anthropic",
    );
    response.end(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await conversations.sizeOf("claude", "session-1")).toBeGreaterThan(0);
    const [day] = await readdir(conversations.directory);
    const [identity] = await readdir(path.join(conversations.directory, day ?? ""));
    const text = await readFile(
      path.join(conversations.directory, day ?? "", identity ?? "", "turns.jsonl"),
      "utf8",
    );
    const turn = JSON.parse(text.trim());
    expect(turn.agent).toBe("claude");
    expect(turn.session).toBe("session-1");
    expect(turn.input).toEqual([{ role: "user", text: "hello" }]);
    expect(turn.output).toEqual([{ role: "assistant", text: "world" }]);

    await conversations.setEnabled(false);
    const second = new FakeResponse();
    conversations.capture(
      fakeRequest({ session: "session-2", body: { messages: [] } }),
      second as unknown as ExpressResponse,
      "anthropic",
    );
    second.end('data: {"type":"content_block_delta","delta":{"text":"ignored"}}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await conversations.sizeOf("claude", "session-2")).toBe(0);

    await conversations.clear();
    expect(await conversations.hasContent()).toBe(false);
  });

  it("keeps deleted gateway sessions hidden until restored", async () => {
    const { conversations } = await fixture();
    expect(await conversations.hiddenSince("codex", "s1")).toBeNull();
    await conversations.hide("codex", "s1", "2026-09-20T10:00:00.000Z");
    expect(await conversations.hiddenSince("codex", "s1")).toBe("2026-09-20T10:00:00.000Z");
    await conversations.unhide("codex", "s1");
    expect(await conversations.hiddenSince("codex", "s1")).toBeNull();
  });
});
