export interface IdentitySyncLogger {
  debug(metaOrMessage: Record<string, unknown> | string, message?: string): void;
  info(metaOrMessage: Record<string, unknown> | string, message?: string): void;
  warn(metaOrMessage: Record<string, unknown> | string, message?: string): void;
  error(metaOrMessage: Record<string, unknown> | string, message?: string): void;
}

export function isIdentitySyncTraceEnabled(): boolean {
  return process.env["IDENTITY_SYNC_TRACE"] === 'true';
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
