/**
 * FEP-1b12 Group Announce wire recognizer (release-disabled).
 *
 * This helper is NOT an authenticity verifier, group-membership store,
 * moderation decision, object dereferencer or ActivityPub delivery executor.
 * The caller must supply a Group actor identity already authenticated as
 * controlled by the verified remote signing/actor-dispatch authority.
 * Nothing here can grant permissions or emit a canonical post.
 *
 * Preserve the original author and the nested object identity. Generic
 * Announce -> ShareAdd translation cannot reconstruct forum semantics.
 */
export interface VerifiedGroupAnnounceInput {
  activity: unknown;
  verifiedActorUri: string;
  verifiedActorType: "Group";
}
export interface GroupAnnounceEnvelope {
  groupActorUri: string;
  announceId: string;
  innerActivityId: string | null;
  contentId: string;
  contentType: "Note" | "Page" | "Article";
  originalAuthorUri: string;
  context: string | null;
  audience: string | null;
}
const ACCEPTED_TYPES = new Set(["Note", "Page", "Article"]);
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function iri(value: unknown): string | null {
  const candidate = typeof value === "string"
    ? value
    : typeof record(value)?.["id"] === "string"
      ? record(value)?.["id"] as string
      : null;
  if (!candidate || candidate.length > 2048 ||
      /[\u0000-\u0020\u007f\\]/u.test(candidate)) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === "https:" && u.href === candidate &&
      !u.username && !u.password ? candidate : null;
  } catch { return null; }
}
function optionalIri(value: unknown): string | null {
  return value === undefined ? null : iri(value);
}
export function recognizeVerifiedGroupAnnounce(
  input: VerifiedGroupAnnounceInput,
): GroupAnnounceEnvelope | null {
  const root = record(input.activity);
  const verifiedGroup = iri(input.verifiedActorUri);
  if (!root || !verifiedGroup || input.verifiedActorType !== "Group" ||
      root["type"] !== "Announce" ||
      iri(root["actor"]) !== verifiedGroup) return null;
  const announceId = iri(root["id"]);
  if (!announceId) return null;
  const inner = record(root["object"]);
  if (!inner) return null; // No speculative URL dereference.
  let content: Record<string, unknown>;
  let originalAuthorUri: string | null;
  let innerActivityId: string | null = null;
  if (inner["type"] === "Create") {
    innerActivityId = iri(inner["id"]);
    originalAuthorUri = iri(inner["actor"]);
    const obj = record(inner["object"]);
    if (!innerActivityId || !obj ||
        !ACCEPTED_TYPES.has(String(obj["type"])) ||
        !originalAuthorUri ||
        iri(obj["attributedTo"]) !== originalAuthorUri) return null;
    content = obj;
  } else if (ACCEPTED_TYPES.has(String(inner["type"]))) {
    content = inner;
    originalAuthorUri = iri(inner["attributedTo"]);
    if (!originalAuthorUri) return null;
  } else {
    return null; // e.g. nested Announce, Flag or moderation Update.
  }
  const contentId = iri(content["id"]);
  const context = optionalIri(content["context"]);
  const audience = optionalIri(content["audience"] ?? inner["audience"]);
  if (!contentId ||
      (content["context"] !== undefined && context === null) ||
      ((content["audience"] ?? inner["audience"]) !== undefined && audience === null)) return null;
  return Object.freeze({
    groupActorUri: verifiedGroup, announceId, innerActivityId,
    contentId, contentType: content["type"] as GroupAnnounceEnvelope["contentType"],
    originalAuthorUri: originalAuthorUri!, context, audience
  });
}
