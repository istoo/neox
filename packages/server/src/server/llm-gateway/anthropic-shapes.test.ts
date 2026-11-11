import { beforeEach, describe, expect, it } from "vitest";
import {
  refuseAnthropicShapes,
  refusedShapes,
  resetAnthropicShapes,
  withoutRefusedShapes,
} from "./anthropic-shapes.js";

const DISPLAY_NEW = "thinking.adaptive.display: Input should be 'summarized' or 'omitted'";
const TURN_EFFORT = "messages.1.output_config: Extra inputs are not permitted";
const ROLE = "Invalid input at messages.1.role";

describe("Anthropic request shapes", () => {
  beforeEach(() => {
    resetAnthropicShapes();
  });

  it("mends a display beyond summarized and omitted", () => {
    const body = { thinking: { type: "adaptive", display: "highlights" } };
    expect(refuseAnthropicShapes({ providerId: "relay", message: DISPLAY_NEW, body })).toEqual([
      "displayNew",
    ]);
    expect(withoutRefusedShapes("relay", body)).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(withoutRefusedShapes("relay", { thinking: { display: "updates" } })).toEqual({
      thinking: {},
    });
    // A provider that refuses the field asks for it gone whole.
    expect(
      refuseAnthropicShapes({
        providerId: "strict",
        message: "thinking.enabled.display: Extra inputs are not permitted",
        body: { thinking: { display: "summarized" } },
      }),
    ).toEqual(["display"]);
    expect(withoutRefusedShapes("strict", { thinking: { display: "summarized" } })).toEqual({
      thinking: {},
    });
    expect(refusedShapes("relay").has("displayNew")).toBe(true);
  });

  it("drops a turn's effort and the system message carrying it alone", () => {
    const body = {
      output_config: { effort: "high" },
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "", output_config: { effort: "high" } },
        { role: "user", content: "go", output_config: { effort: "high" } },
      ],
    };
    expect(refuseAnthropicShapes({ providerId: "relay", message: TURN_EFFORT, body })).toEqual([
      "turnEffort",
    ]);
    const fitted = withoutRefusedShapes("relay", body);
    expect(fitted.output_config).toEqual({ effort: "high" });
    expect(fitted.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "go" },
    ]);
  });

  it("moves a system message's text to the top-level system", () => {
    const body = {
      system: "top",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "tone" }] },
      ],
    };
    expect(refuseAnthropicShapes({ providerId: "relay", message: ROLE, body })).toEqual([
      "turnSystem",
    ]);
    expect(withoutRefusedShapes("relay", body)).toEqual({
      system: [
        { type: "text", text: "top" },
        { type: "text", text: "tone" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("takes deferred-tool blocks away and keeps their definitions", () => {
    const body = {
      tools: [{ name: "read" }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_addition",
              tool: { type: "tool_definition", definition: { name: "grep", input_schema: {} } },
            },
            { type: "text", text: "loaded" },
            { type: "tool_removal", name: "grep" },
          ],
        },
        { role: "user", content: [{ type: "tool_reference", tool_name: "grep" }] },
      ],
    };
    const message = "messages[0].content: unknown variant `tool_removal`";
    expect(refuseAnthropicShapes({ providerId: "relay", message, body })).toEqual(["deferred"]);
    const fitted = withoutRefusedShapes("relay", body);
    expect(fitted.tools).toEqual([{ name: "read" }, { name: "grep", input_schema: {} }]);
    expect(fitted.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "loaded" }] },
    ]);
  });

  it("says which tools a refs-only result loaded", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "tool_reference", tool_name: "grep" }],
            },
          ],
        },
      ],
    };
    expect(
      refuseAnthropicShapes({
        providerId: "relay",
        message: "Failed to deserialize: missing field `content`",
        body,
      }),
    ).toEqual(["refsOnly"]);
    const fitted = withoutRefusedShapes("relay", body);
    expect(fitted.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "Tool grep is loaded and can be called now." },
              { type: "tool_reference", tool_name: "grep" },
            ],
          },
        ],
      },
    ]);
  });

  it("drops safeguards a provider refused", () => {
    const body = { safeguards: { auto: true } };
    expect(
      refuseAnthropicShapes({
        providerId: "relay",
        message: "safeguards: Extra inputs are not permitted",
        body,
      }),
    ).toEqual(["safeguards"]);
    expect(withoutRefusedShapes("relay", body)).toEqual({});
  });

  it("leaves another provider's shapes alone", () => {
    const body = { thinking: { display: "updates" } };
    refuseAnthropicShapes({ providerId: "relay", message: DISPLAY_NEW, body });
    expect(withoutRefusedShapes("other", body)).toEqual(body);
  });
});
