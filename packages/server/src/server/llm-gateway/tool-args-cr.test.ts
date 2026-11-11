import { describe, expect, it } from "vitest";
import { CrDropper, CrLineTidy, dropCR, glmFlash } from "./tool-args-cr.js";

describe("GLM flash tool arguments", () => {
  it("names the models whose replicas stitch with CR", () => {
    expect(glmFlash("glm-5.3-flash")).toBe(true);
    expect(glmFlash("zhipu/glm-5.3-flash-0901")).toBe(true);
    expect(glmFlash("glm-5.3")).toBe(false);
  });

  it("drops a lone CR escape and keeps the pair", () => {
    expect(dropCR('{"a":"x\\ry"}')).toBe('{"a":"xy"}');
    expect(dropCR('{"a":"x\\r\\ny"}')).toBe('{"a":"x\\r\\ny"}');
    expect(dropCR('{"a":"\\\\r"}')).toBe('{"a":"\\\\r"}');
    expect(dropCR('{"a":"x\\u000dy"}')).toBe('{"a":"xy"}');
  });

  it("drops a CR split across streamed pieces", () => {
    const dropper = new CrDropper();
    const pieces = ['{"a":"x\\', "r", 'y"}'];
    const out = pieces.map((piece) => dropper.write(piece)).join("") + dropper.flush();
    expect(out).toBe('{"a":"xy"}');
  });

  it("cures a relayed chat stream a line at a time", () => {
    const tidy = new CrLineTidy("openai");
    const event =
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"a\\":\\"x\\\\ry\\"}"}}]}}]}\n\n';
    expect(tidy.write(event)).toBe(
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"a\\":\\"xy\\"}"}}]}}]}\n\n',
    );
  });

  it("holds a line cut mid-JSON until the piece that ends it arrives", () => {
    const tidy = new CrLineTidy("openai");
    const event =
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"a\\":\\"x\\\\ry\\"}"}}]}}]}\n\n';
    const cut = event.indexOf("\\\\r") + 1;
    expect(tidy.write(event.slice(0, cut))).toBe("");
    expect(tidy.write(event.slice(cut))).toContain('"arguments":"{\\"a\\":\\"xy\\"}"');
    expect(tidy.flush()).toBe("");
  });

  it("forwards a line it cannot parse untouched", () => {
    const tidy = new CrLineTidy("openai");
    expect(tidy.write("data: not json\\r\n\n")).toBe("data: not json\\r\n\n");
    expect(tidy.flush()).toBe("");
  });

  it("reads an escape cut between two events with the event that finishes it", () => {
    const tidy = new CrLineTidy("anthropic");
    const first =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":\\"x\\\\ry\\\\"}}\n\n';
    const second =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"r\\"}"}}\n\n';
    const out = tidy.write(first) + tidy.write(second) + tidy.flush();
    expect(out).toContain('"partial_json":"{\\"a\\":\\"xy"');
    expect(out).toContain('"partial_json":"\\"}"');
    expect(out).not.toContain("\\\\r");
  });

  it("keeps a line ending's CRLF and the event's own number spelling", () => {
    const tidy = new CrLineTidy("openai");
    expect(tidy.write('data: {"choices":[]}\r\n\r\n')).toBe('data: {"choices":[]}\r\n\r\n');
  });
});
