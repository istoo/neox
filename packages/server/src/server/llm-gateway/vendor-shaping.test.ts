import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IrRequest } from "./ir.js";
import {
  chatImages,
  clinePin,
  clinePinBody,
  clineProvider,
  openCodeFree,
  openCodeFreeUrl,
  clineUnwrapped,
  openCodeEnvironment,
  OPEN_CODE_STUB,
  xaiBody,
  zcodeTrialBlocked,
  zcodeTrialRefused,
  ZEN_STUB_NOTE,
  ZenReply,
  zenFreeTools,
} from "./vendor-shaping.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "neolix-vendor-"));
  dirs.push(dir);
  return dir;
}

describe("vendor shaping", () => {
  it("takes Cline's envelope off its reply", () => {
    const ok = clineUnwrapped('{"success":true,"data":{"id":"c","choices":[]}}', 200);
    expect(ok.changed).toBe(true);
    expect(JSON.parse(ok.body)).toEqual({ id: "c", choices: [] });
    const failed = clineUnwrapped('{"success":false,"error":{"message":"nope"}}', 200);
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({ error: { message: "nope" } });
    const kept = clineUnwrapped('{"success":false,"message":"bad"}', 400);
    expect(kept.status).toBe(400);
    expect(JSON.parse(kept.body)).toEqual({ error: { message: "bad" } });
    const other = clineUnwrapped('{"id":"c"}', 200);
    expect(other.changed).toBe(false);
    expect(other.body).toBe('{"id":"c"}');
  });

  it("pins a Cline model to its maker's own API", () => {
    const body = { model: "deepseek-v4", messages: [] };
    expect(clinePin(body, { upstream: "deepseek", openRouter: false })).toEqual({
      model: "deepseek-v4",
      messages: [],
      providerOptions: { gateway: { only: ["deepseek"] } },
    });
    expect(
      clinePin(body, { upstream: "deepseek", openRouter: false, has: ["vision"] }),
    ).toMatchObject({ providerOptions: { gateway: { only: ["deepseek"], has: ["vision"] } } });
    expect(clinePin(body, { upstream: "x", openRouter: true })).toMatchObject({
      provider: { only: ["x"] },
    });
    const named = { model: "m", provider: { only: ["y"] } };
    expect(clinePin(named, { upstream: "x", openRouter: false })).toBe(named);
    expect(chatImages({ messages: [{ content: [{ type: "image_url" }] }] })).toBe(true);
    expect(chatImages({ messages: [{ content: "hi" }] })).toBe(false);
  });

  it("reads ZCode's trial refusals", () => {
    const base = { pluginProvider: "zcode", model: "GLM-5.3-Trial" };
    expect(
      zcodeTrialRefused({
        ...base,
        status: 400,
        body: "zcode: ZCode has no active limited quota for GLM-5.3-Trial",
      }),
    ).toBe(true);
    expect(
      zcodeTrialRefused({
        ...base,
        status: 429,
        body: "ZCode's limited quota for glm-5.3 is exhausted or temporarily unavailable",
      }),
    ).toBe(true);
    expect(
      zcodeTrialRefused({
        ...base,
        status: 429,
        body: "ZCode's limited quota for other is exhausted or temporarily unavailable",
      }),
    ).toBe(false);
    expect(zcodeTrialBlocked({ ...base, status: 405, body: "Sorry, you have been blocked" })).toBe(
      true,
    );
  });

  it("shapes a body as xAI's own API takes it", () => {
    const responses = xaiBody("openai-responses", {
      input: [
        { type: "reasoning", id: "r", content: null, encrypted_content: "x" },
        { type: "message", role: "user", content: "hi" },
      ],
      tools: [{ type: "function", name: "f", parameters: { required: null } }],
    });
    expect(responses.input).toEqual([
      { type: "reasoning", id: "r", encrypted_content: "x" },
      { type: "message", role: "user", content: "hi" },
    ]);
    expect((responses.tools as Record<string, unknown>[])[0]?.parameters).toEqual({});

    const anthropic = xaiBody("anthropic", {
      system: "top",
      messages: [
        { role: "system", content: "mid" },
        { role: "user", content: "hi" },
      ],
      tools: [{ name: "f", input_schema: { anyOf: [{ required: null }], required: ["a"] } }],
    });
    expect(anthropic.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(anthropic.system).toEqual([
      { type: "text", text: "top" },
      { type: "text", text: "mid" },
    ]);
    expect((anthropic.tools as Record<string, unknown>[])[0]?.input_schema).toEqual({
      anyOf: [{}],
      required: ["a"],
    });
  });

  it("sends a Zen free request to OpenCode 2's paths", () => {
    expect(openCodeFree("big-pickle")).toBe(true);
    expect(openCodeFree("glm-5.3-free")).toBe(true);
    expect(openCodeFree("glm-5.3")).toBe(false);
    expect(openCodeFreeUrl("https://opencode.ai/zen/v1/chat/completions", "openai")).toBe(
      "https://opencode.ai/inference/openai/v1/chat/completions",
    );
    expect(openCodeFreeUrl("https://opencode.ai/zen/v1/messages", "anthropic")).toBe(
      "https://opencode.ai/inference/anthropic/v1/messages",
    );
    expect(openCodeFreeUrl("https://opencode.ai/zen/go/v1/chat/completions", "openai")).toBe(
      "https://opencode.ai/zen/go/v1/chat/completions",
    );
    expect(openCodeFreeUrl("https://api.example.com/v1/chat", "openai")).toBe(
      "https://api.example.com/v1/chat",
    );
  });

  it("says OpenCode's environment block", () => {
    const root = tempDir();
    mkdirSync(path.join(root, ".git"));
    const inner = path.join(root, "src");
    mkdirSync(inner);
    const block = openCodeEnvironment(inner, {
      home: root,
      platform: "darwin",
      temp: "/tmp",
    });
    expect(block).toContain("<env>");
    expect(block).toContain(`Working directory: ${realpathSync(inner)}`);
    expect(block).toContain(`Workspace root folder: ${realpathSync(root)}`);
    expect(block).toContain("Is directory a git repo: yes");
    expect(block).toContain("Platform: darwin");
    expect(block).toContain("Prefer /tmp/opencode");
    expect(block).toContain("</env>");
  });

  it("offers Zen its core tools and adds the environment", () => {
    const request: IrRequest = {
      system: "be helpful",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "tool_call", id: "1", name: "Read", arguments: "{}" }],
        },
      ],
      tools: [{ name: "Read", description: "read", inputSchema: { type: "object" } }],
      toolChoice: { name: "Read" },
      format: null,
      maxTokens: null,
      temperature: null,
      topP: null,
      stop: [],
      stream: true,
    };
    const dir = tempDir();
    const shaped = zenFreeTools(request, dir);
    expect(shaped.request.tools.map((tool) => tool.name)).toEqual([
      "read",
      "edit",
      "glob",
      "grep",
      "shell",
    ]);
    expect(shaped.request.tools[0]?.description).toBe("read");
    expect(shaped.request.tools[1]?.description).toBe(OPEN_CODE_STUB);
    expect(shaped.request.tools[1]?.inputSchema).toEqual(
      expect.objectContaining({ type: "object" }),
    );
    expect(shaped.tools.back.get("read")).toBe("Read");
    expect(shaped.tools.stubs.has("shell")).toBe(true);
    expect(shaped.request.messages[0]?.parts[0]).toMatchObject({ name: "read" });
    expect(shaped.request.toolChoice).toEqual({ name: "read" });
    expect(shaped.request.system).toContain("be helpful\n\nHere is some useful information");
  });

  it("hands a Zen reply back with the client's names, and no stub call", () => {
    const reply = new ZenReply({
      back: new Map([["read", "Read"]]),
      stubs: new Set(["shell"]),
    });
    expect(reply.see({ type: "tool_call_start", id: "1", name: "read" })).toEqual([
      { type: "tool_call_start", id: "1", name: "Read" },
    ]);
    expect(reply.see({ type: "tool_args_delta", id: "1", args: "{}" }).length).toBe(1);

    const stubbed = new ZenReply({ back: new Map(), stubs: new Set(["shell"]) });
    expect(stubbed.see({ type: "tool_call_start", id: "2", name: "shell" })).toEqual([]);
    expect(stubbed.see({ type: "tool_args_delta", id: "2", args: "{}" })).toEqual([]);
    expect(stubbed.see({ type: "stop", reason: "tool_use" })).toEqual([
      { type: "text_delta", text: ZEN_STUB_NOTE },
      { type: "stop", reason: "end_turn" },
    ]);
  });

  it("shapes a Zen reply that came whole the same way", () => {
    const reply = new ZenReply({
      back: new Map([["read", "Read"]]),
      stubs: new Set(["shell"]),
    });
    const named = reply.whole({
      id: "m",
      parts: [{ type: "tool_call", id: "1", name: "read", arguments: "{}" }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(named.parts).toEqual([{ type: "tool_call", id: "1", name: "Read", arguments: "{}" }]);
    expect(named.stopReason).toBe("tool_use");

    const stubbed = new ZenReply({ back: new Map(), stubs: new Set(["shell"]) }).whole({
      id: "m",
      parts: [{ type: "tool_call", id: "2", name: "shell", arguments: "{}" }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(stubbed.parts).toEqual([{ type: "text", text: ZEN_STUB_NOTE }]);
    expect(stubbed.stopReason).toBe("end_turn");
  });
});

describe("clinePinBody", () => {
  const cline = { preset: "clinepass", baseUrl: "https://api.cline.bot/v1", pinUpstream: true };

  it("pins a DeepSeek model to DeepSeek's own API (myna ClinePin)", () => {
    const body = clinePinBody({
      provider: cline,
      protocol: "openai",
      body: { model: "deepseek/deepseek-v4-pro", messages: [] },
    });
    expect(body.providerOptions).toEqual({ gateway: { only: ["deepseek"] } });
  });

  it("pins glm-5.3-flash through OpenRouter's provider.only", () => {
    const body = clinePinBody({
      provider: cline,
      protocol: "openai",
      body: { model: "zai/glm-5.3-flash", messages: [] },
    });
    expect(body.provider).toEqual({ only: ["z-ai"] });
  });

  it("carries the vision filter when the request carries an image (ClinePassHas)", () => {
    const body = clinePinBody({
      provider: cline,
      protocol: "openai",
      body: {
        model: "cline-pass/deepseek-v4-pro",
        messages: [{ content: [{ type: "image_url" }] }],
      },
    });
    expect(body.providerOptions).toEqual({
      gateway: { only: ["deepseek"], has: ["vision", "implicit-caching"] },
    });
  });

  it("a provider without pinUpstream, a free model, or another protocol pins nothing", () => {
    const off = { ...cline, pinUpstream: false };
    expect(
      clinePinBody({ provider: off, protocol: "openai", body: { model: "deepseek/x" } }),
    ).toEqual({
      model: "deepseek/x",
    });
    expect(
      clinePinBody({ provider: cline, protocol: "openai", body: { model: "cline-free/x" } }),
    ).toEqual({ model: "cline-free/x" });
    expect(
      clinePinBody({ provider: cline, protocol: "anthropic", body: { model: "deepseek/x" } }),
    ).toEqual({ model: "deepseek/x" });
  });

  it("a body that names providerOptions itself is left as the client sent it", () => {
    const body = clinePinBody({
      provider: cline,
      protocol: "openai",
      body: { model: "deepseek/x", providerOptions: { gateway: { only: ["elsewhere"] } } },
    });
    expect(body).toEqual({
      model: "deepseek/x",
      providerOptions: { gateway: { only: ["elsewhere"] } },
    });
  });

  it("only a Cline host or the clinepass preset is the Cline API", () => {
    expect(clineProvider({ preset: "clinepass", baseUrl: "https://x.example" })).toBe(true);
    expect(clineProvider({ baseUrl: "https://api.cline.bot" })).toBe(true);
    expect(clineProvider({ baseUrl: "https://api.openai.com" })).toBe(false);
  });
});

describe("openCodeFreeUrl wiring", () => {
  it("sends a free model to OpenCode 2's inference paths (m zenfree.go)", () => {
    expect(openCodeFreeUrl("https://opencode.ai/zen/v1", "openai")).toMatch(
      /^https:\/\/opencode\.ai\/inference\//,
    );
  });

  it("a model not free, or a host not OpenCode's, keeps its URL", () => {
    expect(openCodeFree("grok-code")).toBe(true);
    expect(openCodeFree("deepseek-v4-pro")).toBe(false);
  });
});
