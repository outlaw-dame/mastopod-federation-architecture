export interface IdentitySyncLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
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
