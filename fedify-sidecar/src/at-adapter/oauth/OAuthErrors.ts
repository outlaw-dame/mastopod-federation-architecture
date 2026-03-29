import type { FastifyReply } from 'fastify';

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_token'
  | 'invalid_dpop_proof'
  | 'use_dpop_nonce';

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly statusCode: number;
  readonly safeDescription: string;

  constructor(
    code: OAuthErrorCode,
    statusCode: number,
    safeDescription: string,
  ) {
    super(safeDescription);
    this.name = 'OAuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.safeDescription = safeDescription;
  }
}

export function ensureNonEmptyString(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== 'string') {
    throw new OAuthError('invalid_request', 400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new OAuthError('invalid_request', 400, `${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new OAuthError('invalid_request', 400, `${field} is too long`);
  }
  return trimmed;
}

export function boolFromQuery(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function writeOAuthError(
  reply: FastifyReply,
  err: unknown,
  fallbackCode: OAuthErrorCode = 'server_error',
  fallbackStatus = 500,
  dpopNonce?: string,
): FastifyReply {
  const oauthErr = err instanceof OAuthError
    ? err
    : new OAuthError(fallbackCode, fallbackStatus, 'Request failed');

  if (dpopNonce) {
    reply.header('DPoP-Nonce', dpopNonce);
  }

  return reply.status(oauthErr.statusCode).send({
    error: oauthErr.code,
    error_description: oauthErr.safeDescription,
  });
}
