/**
 * V6.5 Phase 7: HTTP AT Password Verifier
 *
 * Delegates password / app-password verification to ActivityPods' internal
 * auth endpoint.  Private keys and password hashes NEVER leave ActivityPods —
 * the sidecar only supplies the canonical account ID and the plaintext
 * password, and receives back the scope granted by that credential.
 *
 * Wire contract (ActivityPods — must be implemented on the AP side):
 *   POST /api/internal/auth/verify
 *   Auth: Bearer <ACTIVITYPODS_TOKEN>
 *   Body: { canonicalAccountId: string; password: string }
 *   200:  { ok: true;  scope: "full" | "app_password_restricted" }
 *   401:  { ok: false; reason: "invalid_password" }
 *   404:  { ok: false; reason: "account_not_found" }
 *
 * Error policy: any failure (wrong password, account not found, network
 * error) throws.  The caller (DefaultAtSessionService) normalises all
 * failures to the same AuthRequired 401 to prevent enumeration.
 *
 * Retry: single attempt only — auth decisions should be deterministic.
 * Transient network errors are bubbled up and handled by the circuit breaker
 * at the edge (load balancer / reverse proxy).
 */

import { request } from 'undici';
import type { AtPasswordVerifier, AtSessionContext } from './AtSessionTypes.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HttpAtPasswordVerifierConfig {
  /** Base URL of the ActivityPods instance, e.g. http://activitypods:3000 */
  baseUrl: string;
  /** Bearer token for the internal auth endpoint (ACTIVITYPODS_TOKEN) */
  token: string;
  /** Per-attempt HTTP timeout in milliseconds (default 10 s) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HttpAtPasswordVerifier implements AtPasswordVerifier {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: HttpAtPasswordVerifierConfig) {
    this.baseUrl   = config.baseUrl;
    this.token     = config.token;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async verify(
    canonicalAccountId: string,
    password: string
  ): Promise<AtSessionContext['scope']> {
    const url = `${this.baseUrl}/api/internal/auth/verify`;

    const res = await request(url, {
      method: 'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${this.token}`,
      },
      body:           JSON.stringify({ canonicalAccountId, password }),
      bodyTimeout:    this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });

    const body = await res.body.json() as any;

    if (res.statusCode === 200 && body?.ok === true) {
      const scope = body.scope;
      if (scope === 'full' || scope === 'app_password_restricted') {
        return scope;
      }
      // Unexpected scope value — treat as auth failure
      throw new Error(`Auth verify: unexpected scope "${scope}"`);
    }

    // 401/404 should be treated as authentication failures, not internal errors.
    if (res.statusCode === 401 || res.statusCode === 404) {
      const err: any = new Error(
        `Auth verify failed (HTTP ${res.statusCode}): ${body?.reason ?? 'unknown'}`
      );
      err.status = 401;
      err.code = 'AUTH_FAILED';
      throw err;
    }

    // Other non-2xx responses are unexpected and treated as internal failures.
    throw new Error(
      `Auth verify failed (HTTP ${res.statusCode}): ${body?.reason ?? 'unknown'}`
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHttpAtPasswordVerifier(
  overrides?: Partial<HttpAtPasswordVerifierConfig>
): HttpAtPasswordVerifier {
  return new HttpAtPasswordVerifier({
    baseUrl:   process.env.ACTIVITYPODS_URL   ?? 'http://localhost:3000',
    token:     process.env.ACTIVITYPODS_TOKEN ?? '',
    timeoutMs: 10_000,
    ...overrides,
  });
}
