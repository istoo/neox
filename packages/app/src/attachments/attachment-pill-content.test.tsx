import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { getAgentAttachmentPillContent } from "./attachment-pill-content";

describe("agent attachment pill content", () => {
  it("presents external resources with their provider identity", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "ENG-123 Plugin attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        externalResource: {
          provider: "linear",
          providerLabel: "Linear issue",
          resourceType: "issue",
          id: "issue-uuid",
          identifier: "ENG-123",
          title: "Plugin attachments",
          url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        },
      },
      i18n.t,
    );

    expect(content.title).toBe("Plugin attachments");
    expect(content.subtitle).toBe("Linear issue ENG-123");
  });

  it("presents a stored image the daemon kept for the thread", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "stored_image",
        id: "0f8fad5b-d9cb-469f-a165-70867728950e",
        fileName: "shot.png",
        mimeType: "image/png",
        size: 8,
        path: "/home/.neox/attachments/0f8fad5b-d9cb-469f-a165-70867728950e.png",
      },
      i18n.t,
    );

    expect(content.title).toBe("shot.png");
    expect(content.subtitle).toBe("PNG");
  });
});
