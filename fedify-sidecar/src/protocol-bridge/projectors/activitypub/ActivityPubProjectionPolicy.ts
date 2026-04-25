export type ActivityPubNoteLinkPreviewMode =
  | "disabled"
  | "attachment_only"
  | "attachment_and_preview";

export interface ActivityPubProjectionPolicy {
  noteLinkPreviewMode: ActivityPubNoteLinkPreviewMode;
}

export const DEFAULT_ACTIVITYPUB_PROJECTION_POLICY: ActivityPubProjectionPolicy = {
  noteLinkPreviewMode: "attachment_only",
};

export function normalizeActivityPubNoteLinkPreviewMode(
  value: string | null | undefined,
): ActivityPubNoteLinkPreviewMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "":
    case "attachment_only":
    case "attachment-only":
    case "mastodon_safe":
    case "mastodon-safe":
      return "attachment_only";
    case "attachment_and_preview":
    case "attachment-and-preview":
    case "rich":
      return "attachment_and_preview";
    case "disabled":
    case "off":
    case "none":
      return "disabled";
    default:
      return DEFAULT_ACTIVITYPUB_PROJECTION_POLICY.noteLinkPreviewMode;
  }
}
