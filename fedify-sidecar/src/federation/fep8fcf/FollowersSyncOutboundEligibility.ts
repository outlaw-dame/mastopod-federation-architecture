const MAX_ACTIVITY_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RECIPIENTS = 10_000;

function normalizeRecipientValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Decide whether an already-serialized outbound ActivityPub activity is
 * addressed to the local actor's followers collection.
 *
 * FEP-8fcf is an optional repair optimization, never a delivery requirement.
 * This helper therefore fails closed to "not eligible" on malformed or
 * unexpectedly large activity JSON rather than affecting normal delivery.
 */
export function isFollowersAddressedActivity(
  activityBody: string,
  actorUri: string,
): boolean {
  if (Buffer.byteLength(activityBody, "utf8") > MAX_ACTIVITY_JSON_BYTES) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(activityBody);
  } catch {
    return false;
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return false;

  const normalizedActor = actorUri.endsWith("/") ? actorUri.slice(0, -1) : actorUri;
  const followersUri = `${normalizedActor}/followers`;
  const record = parsed as Record<string, unknown>;
  const recipients = [
    ...normalizeRecipientValues(record["to"]),
    ...normalizeRecipientValues(record["cc"]),
    ...normalizeRecipientValues(record["bto"]),
    ...normalizeRecipientValues(record["bcc"]),
    ...normalizeRecipientValues(record["audience"]),
  ];

  return recipients.includes(followersUri);
}
