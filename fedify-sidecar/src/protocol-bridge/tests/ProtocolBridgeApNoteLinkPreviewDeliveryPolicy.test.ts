import { describe, expect, it } from "vitest";
import {
  applyActivityPubOutboundDeliveryPolicy,
  normalizeActivityPubDomainRuleList,
  resolveOutboundNoteLinkPreviewMode,
} from "../projectors/activitypub/ActivityPubDeliveryPolicy.js";

describe("AP outbound note link preview delivery policy", () => {
  it("upgrades attachment-only note cards to preview-bearing output for rich domains", () => {
    const activity = applyActivityPubOutboundDeliveryPolicy(
      {
        type: "Create",
        object: {
          type: "Note",
          attachment: [
            {
              type: "Document",
              mediaType: "text/html",
              url: "https://example.com/page",
              name: "Example Page",
              summary: "Example description",
            },
          ],
        },
      },
      "rich.example",
      {
        noteLinkPreviewUrls: ["https://example.com/page"],
      },
      {
        defaultNoteLinkPreviewMode: "attachment_only",
        richNoteLinkPreviewDomains: ["rich.example"],
        disabledNoteLinkPreviewDomains: [],
      },
    );

    expect(activity).toEqual(
      expect.objectContaining({
        object: expect.objectContaining({
          attachment: expect.arrayContaining([
            expect.objectContaining({
              url: "https://example.com/page",
            }),
          ]),
          preview: expect.objectContaining({
            url: "https://example.com/page",
          }),
        }),
      }),
    );
  });

  it("removes only hinted note preview cards for disabled domains", () => {
    const activity = applyActivityPubOutboundDeliveryPolicy(
      {
        type: "Create",
        object: {
          type: "Note",
          preview: {
            type: "Document",
            mediaType: "text/html",
            url: "https://example.com/page",
            name: "Example Page",
          },
          attachment: [
            {
              type: "Image",
              mediaType: "image/png",
              url: "https://cdn.example.com/photo.png",
            },
            {
              type: "Document",
              mediaType: "text/html",
              url: "https://example.com/page",
              name: "Example Page",
            },
          ],
        },
      },
      "mastodon.social",
      {
        noteLinkPreviewUrls: ["https://example.com/page"],
      },
      {
        defaultNoteLinkPreviewMode: "attachment_and_preview",
        richNoteLinkPreviewDomains: [],
        disabledNoteLinkPreviewDomains: ["mastodon.social"],
      },
    );

    expect(activity).toEqual(
      expect.objectContaining({
        object: expect.objectContaining({
          attachment: [
            expect.objectContaining({
              type: "Image",
              url: "https://cdn.example.com/photo.png",
            }),
          ],
        }),
      }),
    );
    const object = activity["object"] as Record<string, unknown>;
    expect(object["preview"]).toBeUndefined();
  });

  it("normalizes domain rules and matches subdomains safely", () => {
    const rules = normalizeActivityPubDomainRuleList(`
      rich.example
      https://preview.remote.example
      invalid/path
    `);

    expect(rules).toEqual(["rich.example", "preview.remote.example"]);
    expect(resolveOutboundNoteLinkPreviewMode("files.rich.example", {
      defaultNoteLinkPreviewMode: "attachment_only",
      richNoteLinkPreviewDomains: rules,
      disabledNoteLinkPreviewDomains: ["mastodon.social"],
    })).toBe("attachment_and_preview");
    expect(resolveOutboundNoteLinkPreviewMode("mastodon.social", {
      defaultNoteLinkPreviewMode: "attachment_only",
      richNoteLinkPreviewDomains: rules,
      disabledNoteLinkPreviewDomains: ["mastodon.social"],
    })).toBe("disabled");
  });
});
