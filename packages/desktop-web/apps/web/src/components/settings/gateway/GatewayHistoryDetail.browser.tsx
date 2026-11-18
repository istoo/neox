import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { GatewayArchiveRecord, GatewayRouteHistoryRow } from "~/lib/gatewayTypes";

const fixture = vi.hoisted(() => ({
  archive: vi.fn(),
  prompt: vi.fn(),
  reply: vi.fn(),
  heldRead: vi.fn(),
  heldReveal: vi.fn(),
}));

vi.mock("~/lib/neolixGatewayApi", () => ({
  neolixGatewayApi: {
    getArchive: fixture.archive,
    getPromptText: fixture.prompt,
    getPromptReply: fixture.reply,
    heldRead: fixture.heldRead,
    heldReveal: fixture.heldReveal,
  },
}));

import { GatewayHistoryDetail } from "./GatewayHistoryDetail";
import { resetJsonFolds } from "./jsonTree.logic";

const row: GatewayRouteHistoryRow = {
  id: "call-1",
  time: "2026-11-14T10:00:00.000Z",
  asked: "claude-sonnet",
  served: "claude-sonnet",
  client: "claude-code",
  status: 200,
  millis: 1200,
  archive: "2026-11-14/call-1",
  tries: [{ provider: "anthropic", model: "claude-sonnet", status: 200, millis: 1200 }],
  prompt: { tokens: 1234, parts: [{ kind: "text", tokens: 1200 }] },
};

function archive(overrides: Partial<GatewayArchiveRecord> = {}): GatewayArchiveRecord {
  return {
    id: "call-1",
    time: row.time,
    request: {
      method: "POST",
      path: "/v1/messages",
      headers: {},
      body: "REQUEST BODY",
    },
    response: {
      status: 200,
      headers: {},
      body: "RESPONSE BODY",
    },
    upstream: [],
    ...overrides,
  };
}

function detail(input: GatewayRouteHistoryRow, onEditArchive?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <GatewayHistoryDetail row={input} onEditArchive={onEditArchive} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetJsonFolds();
  fixture.archive.mockResolvedValue(archive());
  fixture.prompt.mockResolvedValue({ id: "call-1", protocol: "anthropic", body: "PROMPT BODY" });
  fixture.reply.mockResolvedValue({
    pieces: [
      { role: "assistant", text: "REPLY PIECE" },
      { role: "call", name: "search", text: "TOOL PIECE" },
    ],
  });
  fixture.heldRead.mockResolvedValue({ text: "HELD CALL REPORT" });
  fixture.heldReveal.mockResolvedValue({ ok: true });
});

describe("gateway request diagnostics", () => {
  it("opens the request and shows the prompt and reply of the call", async () => {
    await render(detail(row));

    await expect.element(page.getByText("REQUEST BODY")).toBeVisible();
    // The call's decision chain is part of the same detail, with the try's
    // own duration.
    await expect
      .element(page.getByText("Tried anthropic/claude-sonnet · 200 · 1200ms"))
      .toBeVisible();

    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect.element(page.getByText("PROMPT BODY")).toBeVisible();
    await expect
      .element(page.getByText("Secrets were taken out before the body was kept."))
      .toBeVisible();

    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect.element(page.getByText("REPLY PIECE")).toBeVisible();
    await expect.element(page.getByText("TOOL PIECE")).toBeVisible();
    await expect.element(page.getByText(/Tool call · search/)).toBeVisible();
  });

  it("draws a try a record kept without a provider as its model alone", async () => {
    // Records written before tries named their provider kept the seat as
    // `provider/model` in `model`; the page shows what it has, not "?".
    await render(
      detail({
        ...row,
        served: "fake/sweep-model",
        tries: [{ model: "fake/sweep-model", status: 200 }],
      }),
    );

    const line = page.getByText("Tried fake/sweep-model · 200", { exact: true });
    await expect.element(line).toBeVisible();
    expect(line.element().textContent).toBe("Tried fake/sweep-model · 200");
    await expect.element(page.getByText(/\?\/fake\/sweep-model/)).not.toBeInTheDocument();
  });

  it("leaves out a status and a duration a try never had", async () => {
    await render(
      detail({
        ...row,
        tries: [{ provider: "fake", model: "sweep-model" }],
      }),
    );

    const line = page.getByText("Tried fake/sweep-model", { exact: true });
    await expect.element(line).toBeVisible();
    expect(line.element().textContent).toBe("Tried fake/sweep-model");
  });

  it("reads a streamed response as events, raw text, and the reply it spells", async () => {
    fixture.archive.mockResolvedValue(
      archive({
        response: {
          status: 200,
          headers: { "content-type": ["text/event-stream"] },
          body: [
            'data: {"type":"message_start","message":{"id":"msg_1","model":"claude"}}',
            "",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
            "",
          ].join("\n"),
        },
      }),
    );
    await render(detail(row));

    await page.getByRole("button", { name: "Response", exact: true }).click();
    await expect.element(page.getByText("2 events")).toBeVisible();
    await expect.element(page.getByText("Hello")).toBeVisible();

    await page.getByRole("button", { name: "Raw", exact: true }).click();
    await expect.element(page.getByText(/text\/event-stream|message_start/)).toBeVisible();

    // The tab and the SSE reading are both named Reply; this picks the reading's.
    await page.getByRole("button", { name: "Reply", exact: true }).last().click();
    await expect.element(page.getByText(/"id": "msg_1"/)).toBeVisible();
  });

  it("reads a JSON body as a foldable tree and keeps text bodies as text", async () => {
    fixture.archive.mockResolvedValue(
      archive({
        request: {
          method: "POST",
          path: "/v1/messages",
          headers: {},
          body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] }),
        },
      }),
    );
    await render(detail(row));

    await expect.element(page.getByText(/"model":/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy model value" })).toBeVisible();

    await page.getByRole("button", { name: "Collapse the JSON body" }).click();
    expect(page.getByText(/"model":/).query()).toBeNull();
    await page.getByRole("button", { name: "Expand the JSON body" }).click();
    await expect.element(page.getByText(/"model":/)).toBeVisible();
  });

  it("shows the held report of the call", async () => {
    await render(detail({ ...row, held: "held-1.txt" }));
    await expect.element(page.getByText("Held reports")).toBeVisible();
    await expect.element(page.getByText("HELD CALL REPORT")).toBeVisible();
  });

  it("says what to turn on when a call was not archived", async () => {
    const onEditArchive = vi.fn();
    await render(detail({ ...row, archive: undefined }, onEditArchive));

    await expect.element(page.getByText(/Turn on Request archive under Advanced/)).toBeVisible();
    await page.getByRole("button", { name: "Open Advanced › Request archive" }).click();
    expect(onEditArchive).toHaveBeenCalledOnce();

    // The prompt text may still be in memory even when the archive did not keep the call.
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect.element(page.getByText("PROMPT BODY")).toBeVisible();
  });
});
