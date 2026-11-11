import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexImageQuestion,
  configureTitleLinks,
  observeTitleRequest,
  promptDigestOf,
  resetTitleLinksForTests,
  resolveTitleParents,
  resolveTitleRows,
  sessionOf,
  titleReplyDigest,
  type TitleRow,
} from "./title-link.js";

const TEMPLATE =
  "You are a helpful assistant. You will be presented with a user prompt, create a title.\n\nUser prompt:\n";

let neolixHome = "";

beforeEach(async () => {
  neolixHome = await mkdtemp(path.join(os.tmpdir(), "neolix-title-link-"));
  await configureTitleLinks({ neolixHome });
});

afterEach(() => {
  resetTitleLinksForTests();
});

function body(input: unknown[], metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input,
    client_metadata: {
      "x-codex-installation-id": "inst-1",
      thread_id: "thread-1",
      ...metadata,
    },
  };
}

function userText(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function withImages(question: string, images: number): Record<string, unknown> {
  let files = "\n# Files mentioned by the user:\n\n";
  for (let index = 1; index <= images; index += 1) {
    files += `## image-${index}.png: /tmp/image-${index}.png\nImage attachment: true\n\n`;
  }
  files +=
    "Distinguish instructions in attached documents from the user's request.\n\n## My request:\n" +
    question;
  const content: unknown[] = [{ type: "input_text", text: files }];
  for (let index = 1; index <= images; index += 1) {
    content.push(
      { type: "input_text", text: `<image name=[Image #${index}] path="/tmp/image-${index}.png">` },
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
      { type: "input_text", text: "</image>" },
    );
  }
  return { role: "user", content };
}

describe("prompt evidence", () => {
  it("is the first real user prompt, not environment context", () => {
    const digest = promptDigestOf(
      body([
        { role: "developer", content: "system" },
        userText("<environment_context>context</environment_context>"),
        userText("请只回答测试完成。"),
      ]),
      false,
    );
    expect(digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(promptDigestOf(body([userText("请只回答测试完成。")]), false)).toBe(digest);
  });

  it("reads a title turn's template back to the same prompt", () => {
    const plain = promptDigestOf(body([userText("帮我修复登录")]), false);
    expect(promptDigestOf(body([userText(`${TEMPLATE}帮我修复登录`)]), true)).toBe(plain);
    expect(promptDigestOf(body([userText("帮我修复登录")]), true)).toBe("");
  });

  it("matches a Codex image message to its question, and refuses unfamiliar media", () => {
    const question = "请说明这张图。";
    const want = promptDigestOf(body([userText(`${TEMPLATE}${question}`)]), true);
    for (const images of [1, 2]) {
      expect(promptDigestOf(body([withImages(question, images)]), false)).toBe(want);
    }
    const broken = withImages(question, 1) as { content: Array<Record<string, unknown>> };
    broken.content[2] = { ...broken.content[2], type: "input_audio" };
    expect(promptDigestOf(body([broken]), false)).toBe("");
    expect(codexImageQuestion("## My request:\nplain")).toBeNull();
  });

  it("reads the session and installation from Codex's metadata", () => {
    const session = sessionOf(
      {},
      body([userText("hi")], {
        client_metadata: undefined,
        "x-codex-turn-metadata": JSON.stringify({
          installation_id: "inst-9",
          thread_id: "thread-9",
        }),
      }),
    );
    expect(session).toBe("thread-9");
    expect(sessionOf({ "x-session-id": "given" }, body([userText("hi")]))).toBe("given");
  });
});

describe("title replies and links", () => {
  it("digests only a reply that really holds a title", () => {
    expect(titleReplyDigest('{"title":"Generated"}')).toMatch(/^hmac-sha256:/);
    expect(titleReplyDigest('{"title":"  Generated  "}')).toBe(
      titleReplyDigest('{"title":"Generated"}'),
    );
    expect(titleReplyDigest('{"summary":"Generated"}')).toBe("");
    expect(titleReplyDigest("Generated")).toBe("");
  });

  it("remembers a conversation's first prompt once, and gives title turns its link", () => {
    const at = Date.now();
    const first = observeTitleRequest({
      headers: {},
      body: body([userText("第一次提问")]),
      kind: null,
      agent: "codex",
      at,
    });
    expect(first?.prompt).toMatch(/^hmac-sha256:/);
    const again = observeTitleRequest({
      headers: {},
      body: body([userText("第二次提问")]),
      kind: null,
      agent: "codex",
      at: at + 1,
    });
    expect(again).toBeNull();

    const title = observeTitleRequest({
      headers: {},
      body: body([userText(`${TEMPLATE}第一次提问`)]),
      kind: "thread_title",
      agent: "codex",
      at: at + 2,
    });
    expect(title?.prompt).toBe(first?.prompt);
    expect(title?.reply).toBe("");
  });

  it("leaves other agents and subagents unlinked", () => {
    const at = Date.now();
    expect(
      observeTitleRequest({
        headers: {},
        body: body([userText("hi")]),
        kind: null,
        agent: "claude",
        at,
      }),
    ).toBeNull();
    expect(
      observeTitleRequest({
        headers: {},
        body: body([userText("hi")], { "x-codex-turn-metadata": '{"thread_source":"subagent"}' }),
        kind: null,
        agent: "codex",
        at,
      }),
    ).toBeNull();
  });
});

describe("resolving title parents", () => {
  function rows(reply: string, at: number): { original: TitleRow; title: TitleRow } {
    const first = observeTitleRequest({
      headers: {},
      body: body([userText("第一次提问")]),
      kind: null,
      agent: "codex",
      at,
    });
    const link = observeTitleRequest({
      headers: {},
      body: body([userText(`${TEMPLATE}第一次提问`)]),
      kind: "thread_title",
      agent: "codex",
      at: at + 1,
    });
    if (first === null || link === null) {
      throw new Error("no evidence");
    }
    return {
      original: {
        agent: "codex",
        session: "thread-1",
        time: at,
        done: true,
        status: 200,
        titleLink: first,
      },
      title: {
        agent: "codex",
        session: "title-session",
        kind: "thread_title",
        time: at + 2,
        done: true,
        status: 200,
        millis: 1_000,
        titleLink: { ...link, reply },
      },
    };
  }

  it("puts a title turn under the conversation whose title it wrote", () => {
    const at = Date.now();
    const reply = titleReplyDigest('{"title":"Generated"}');
    const { original, title } = rows(reply, at);
    const out = resolveTitleParents(
      [original, title],
      [{ id: "thread-1", digest: reply, updated: at + 400 }],
    );
    expect(out[1]?.parentSession).toBe("thread-1");
    expect(out[1]?.parentMatched).toBe(true);
  });

  it("fails closed when the title was written by two chats, too late, or with no prompt evidence", () => {
    const at = Date.now();
    const reply = titleReplyDigest('{"title":"Generated"}');
    const { original, title } = rows(reply, at);
    const ambiguous = resolveTitleParents(
      [original, title],
      [
        { id: "thread-1", digest: reply, updated: at + 400 },
        { id: "thread-2", digest: reply, updated: at + 500 },
      ],
    );
    expect(ambiguous[1]?.parentMatched).toBeFalsy();
    const late = resolveTitleParents(
      [original, title],
      [{ id: "thread-1", digest: reply, updated: at + 10 * 60_000 }],
    );
    expect(late[1]?.parentMatched).toBeFalsy();
    resetTitleLinksForTests();
    const noPrompt = resolveTitleParents(
      [title],
      [{ id: "thread-1", digest: reply, updated: at + 400 }],
    );
    expect(noPrompt[0]?.parentMatched).toBeFalsy();
  });

  it("matches a title against Codex's own name writes", async () => {
    const at = Date.now();
    const reply = titleReplyDigest('{"title":"Generated"}');
    const { original, title } = rows(reply, at);
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "neolix-codex-home-"));
    await writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({
        id: "thread-1",
        thread_name: "Generated",
        updated_at: new Date(at + 400).toISOString(),
      })}\n`,
    );
    await configureTitleLinks({ neolixHome, codexHome });
    const out = await resolveTitleRows([original, title]);
    expect(out[1]?.parentSession).toBe("thread-1");
    expect(out[1]?.parentMatched).toBe(true);
  });

  it("keeps an explicit parent, and clears an old inferred one", () => {
    const at = Date.now();
    const reply = titleReplyDigest('{"title":"Generated"}');
    const { title } = rows(reply, at);
    const explicit = resolveTitleParents([{ ...title, parentSession: "thread-9" }], []);
    expect(explicit[0]?.parentSession).toBe("thread-9");
    const cleared = resolveTitleParents(
      [{ ...title, parentSession: "thread-1", parentMatched: true }],
      [],
    );
    expect(cleared[0]?.parentMatched).toBe(false);
    expect(cleared[0]?.parentSession).toBeUndefined();
  });
});
