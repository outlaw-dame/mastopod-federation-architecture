export function sanitizeOptionalText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';

  return input
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}
