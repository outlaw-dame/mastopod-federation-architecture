export function getBackoffDelay(attempt: number, base = 500): number {
  const jitter = Math.random() * 100;
  return Math.min(base * 2 ** attempt + jitter, 30000);
}
