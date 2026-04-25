export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  const withoutPrefix = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return withoutPrefix.replace(/\s+/g, "").toLowerCase();
}
