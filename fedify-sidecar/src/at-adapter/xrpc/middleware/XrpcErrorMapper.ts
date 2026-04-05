/**
 * V6.5 Phase 4: XRPC Error Mapper
 *
 * Maps internal errors to stable, spec-compliant XRPC HTTP responses.
 *
 * ATProto XRPC errors follow the shape:
 *   { "error": "<ErrorName>", "message": "<human-readable>" }
 *
 * Error names are taken from the Lexicon error vocabulary where possible.
 * Internal stack traces and implementation details are NEVER forwarded to
 * the caller — all 5xx responses return a generic message.
 *
 * Ref: https://atproto.com/specs/xrpc
 */

// ---------------------------------------------------------------------------
// Typed XRPC error
// ---------------------------------------------------------------------------

export type XrpcErrorName =
  | 'InvalidRequest'
  | 'NotFound'
  | 'RepoNotFound'
  | 'RecordNotFound'
  | 'HandleNotFound'
  | 'InvalidDid'
  | 'InvalidHandle'
  | 'InvalidCursor'
  | 'InvalidCollection'
  | 'InvalidRkey'
  | 'RepoDeactivated'
  | 'RepoTakendown'
  | 'UnsupportedAlgorithm'
  | 'InternalServerError'
  // Phase 7: auth + write errors
  | 'AuthRequired'
  | 'Forbidden'
  | 'UnsupportedCollection'
  | 'WriteNotAllowed'
  | 'WriteTimeout'
  | 'InvalidSwap';

export class XrpcError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: XrpcErrorName,
    message: string
  ) {
    super(message);
    this.name = 'XrpcError';
    // Preserve prototype chain in compiled JS
    Object.setPrototypeOf(this, XrpcError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

export const XrpcErrors = {
  invalidRequest: (msg: string) => new XrpcError(400, 'InvalidRequest', msg),
  invalidDid: (did: string) => new XrpcError(400, 'InvalidDid', `Invalid DID format: ${did}`),
  invalidHandle: (handle: string) => new XrpcError(400, 'InvalidHandle', `Invalid handle format: ${handle}`),
  invalidCursor: (cursor: string) => new XrpcError(400, 'InvalidCursor', `Invalid cursor: ${cursor}`),
  invalidCollection: (col: string) => new XrpcError(400, 'InvalidCollection', `Invalid collection NSID: ${col}`),
  invalidRkey: (rkey: string) => new XrpcError(400, 'InvalidRkey', `Invalid rkey: ${rkey}`),
  repoNotFound: (did: string) => new XrpcError(404, 'RepoNotFound', `Repo not found: ${did}`),
  recordNotFound: (uri: string) => new XrpcError(404, 'RecordNotFound', `Record not found: ${uri}`),
  handleNotFound: (handle: string) => new XrpcError(404, 'HandleNotFound', `Handle not found: ${handle}`),
  repoDeactivated: (did: string) => new XrpcError(400, 'RepoDeactivated', `Repo is deactivated: ${did}`),
  repoTakendown: (did: string) => new XrpcError(400, 'RepoTakendown', `Repo is taken down: ${did}`),
  internal: () => new XrpcError(500, 'InternalServerError', 'An unexpected error occurred'),
  // Phase 7: auth + write errors
  authRequired: (msg = 'Authentication required') => new XrpcError(401, 'AuthRequired', msg),
  forbidden: (msg: string) => new XrpcError(403, 'Forbidden', msg),
  unsupportedCollection: (col: string) => new XrpcError(400, 'UnsupportedCollection', `Collection not supported: ${col}`),
  writeNotAllowed: (msg: string) => new XrpcError(403, 'WriteNotAllowed', msg),
  writeTimeout: () => new XrpcError(503, 'WriteTimeout', 'Write result not available; retry the request'),
  invalidSwap: (msg: string) => new XrpcError(400, 'InvalidSwap', msg),
} as const;

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export interface XrpcErrorResponse {
  status: number;
  body: { error: string; message: string };
}

export function mapToXrpcError(err: unknown): XrpcErrorResponse {
  if (err instanceof XrpcError) {
    return {
      status: err.status,
      body: { error: err.error, message: err.message }
    };
  }

  // Log the real error internally (in production this would go to a structured
  // logger, never to the response body).
  if (process.env['NODE_ENV'] !== 'test') {
    console.error('[XrpcErrorMapper] Unhandled internal error:', err);
  }

  return {
    status: 500,
    body: { error: 'InternalServerError', message: 'An unexpected error occurred' }
  };
}
