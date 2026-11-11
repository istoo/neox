import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderInlineCode } from "./inlineCode";

const html = (text: string) => renderToStaticMarkup(<>{renderInlineCode(text)}</>);

describe("renderInlineCode", () => {
  it("turns backticked spans into code", () => {
    expect(html("打开 `keybindings.json` 文件")).toBe("打开 <code>keybindings.json</code> 文件");
  });

  it("leaves text without a backtick pair unchanged", () => {
    expect(renderInlineCode("plain")).toBe("plain");
    expect(html("one ` tick")).toBe("one ` tick");
  });

  it("keeps an unmatched trailing backtick literal", () => {
    expect(html("`a` and `b")).toBe("<code>a</code> and b");
  });
});
