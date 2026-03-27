export interface IdentitySyncLogger {
  debug(message: string | Record<string, unknown>, meta?: string): void;
  info(message: string | Record<string, unknown>, meta?: string): void;
  warn(message: string | Record<string, unknown>, meta?: string): void;
  error(message: string | Record<string, unknown>, meta?: string): void;
}

export function isIdentitySyncTraceEnabled(): boolean {
  return process.env.IDENTITY_SYNC_TRACE === 'true';
}

export function traceIdentitySync(
  logger: IdentitySyncLogger | undefined,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>
): void {
  if (!isIdentitySyncTraceEnabled()) return;
  if (!logger) return;

  if (meta && Object.keys(meta).length > 0) {
    logger[level]({ ...meta }, `[identity-sync] ${message}`);
    return;
  }

  logger[level](`[identity-sync] ${message}`);
}
