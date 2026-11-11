import { describe, expect, it } from "vitest";
import type { IrMessage, IrPart } from "./ir.js";
import { lostMedia } from "./vision-lost-media.js";

// myna's claude_lost_media_test.go, in IR: an image a client took out of its
// conversation is told from every other change by the conversation's shape.
const read = "Read image file [image/png]";
const gone = "[图片已省略：历史图片保留为文件引用，避免重复发送原始 base64]";

function user(...parts: IrPart[]): IrMessage {
  return { role: "user", parts };
}

function text(value: string): IrPart {
  return { type: "text", text: value };
}

function image(data = "c2NyZWVuc2hvdA=="): IrPart {
  return { type: "image", mediaType: "image/png", data };
}

function calls(...ids: string[]): IrMessage {
  return {
    role: "assistant",
    parts: ids.map((id, index) => ({
      type: "tool_call" as const,
      id,
      name: "read",
      arguments: JSON.stringify({ path: `shot${index + 1}.png` }),
    })),
  };
}

function result(id: string, content: string): IrMessage {
  return {
    role: "tool",
    parts: [{ type: "tool_result", toolCallId: id, content, isError: false }],
  };
}

function ask(question: string): IrMessage {
  return user(text(question));
}

describe("images taken out of a conversation", () => {
  const question = ask("看看这几张截图");

  it("sees a user's image replaced by the line", () => {
    expect(lostMedia([user(text("这是什么"), image())], [user(text("这是什么"), text(gone))])).toBe(
      true,
    );
  });

  it("sees a user's image left out, its text kept", () => {
    expect(
      lostMedia(
        [user(text("看 [attached_image: /tmp/a.png]"), image())],
        [user(text("看 [attached_image: /tmp/a.png]"))],
      ),
    ).toBe(true);
  });

  it("sees images before the user's text replaced", () => {
    expect(
      lostMedia(
        [user(image(), image(), text("这两张有什么不同"))],
        [user(text(gone), text(gone), text("这两张有什么不同"))],
      ),
    ).toBe(true);
  });

  it("sees images in an older turn left out", () => {
    expect(
      lostMedia(
        [question, calls("call_1"), result("call_1", read), user(image())],
        [question, calls("call_1"), result("call_1", read), user(text("and now?"))],
      ),
    ).toBe(true);
  });

  it("does not mistake an unchanged conversation for one", () => {
    expect(
      lostMedia(
        [question, calls("call_1"), result("call_1", read)],
        [question, calls("call_1"), result("call_1", read)],
      ),
    ).toBe(false);
  });

  it("does not mistake text added after the user's words for an image gone", () => {
    expect(
      lostMedia(
        [user(image(), text("这是什么"))],
        [user(text(gone), text("这是什么"), text("还有这个"))],
      ),
    ).toBe(false);
  });

  it("does not mistake the user's words changed beside the image", () => {
    expect(lostMedia([user(text("这是什么"), image())], [user(text("这是谁"), text(gone))])).toBe(
      false,
    );
  });

  it("does not mistake text added to a result with no image", () => {
    expect(
      lostMedia(
        [question, calls("call_1"), result("call_1", "A")],
        [question, calls("call_1"), result("call_1", "A and more")],
      ),
    ).toBe(false);
  });

  it("does not mistake a changed result beside an image gone elsewhere", () => {
    expect(
      lostMedia(
        [question, calls("call_1"), result("call_1", read), user(image())],
        [question, calls("call_1"), result("call_1", "A and more"), user(image())],
      ),
    ).toBe(false);
  });

  it("does not mistake a compacted conversation for one", () => {
    expect(
      lostMedia(
        [question, calls("call_1"), result("call_1", read), user(image())],
        [user(text("a summary of the conversation so far"))],
      ),
    ).toBe(false);
  });

  it("does not mistake a placeholder where no image was", () => {
    expect(lostMedia([user(text("这是什么"))], [user(text("这是什么"), text(gone))])).toBe(false);
  });
});
