export function sanitizeAltText(input: string): string {
  if (!input) return '';

  return input
    .replace(/<[^>]*>/g, '') // strip HTML
    .replace(/[\u0000-\u001F\u007F]/g, '') // remove control chars
    .trim()
    .slice(0, 500);
}

export function sanitizeContentWarning(input?: string): string | undefined {
  if (!input) return undefined;

  return input
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 300);
}
