/**
 * V6.5 Phase 7: HTTP AT Password Verifier
 *
 * Delegates password / app-password verification to ActivityPods' dedicated
 * internal auth endpoint. Private keys and password hashes NEVER leave
 * ActivityPods. The sidecar supplies only the canonical account ID and the
 * plaintext credential and receives the granted session scope.
 *
 * Wire contract:
 *   POST /api/internal/auth/verify
 *   Auth: Bearer <ATPROTO_PASSWORD_VERIFY_TOKEN>
 *   Body: { canonicalAccountId: string; password: string }
 *   200: { ok: true, scope: "full" | "app_password_restricted" }
 *   401: { ok: false, reason: "invalid_credentials" }
 *
 * The password-verification capability is intentionally separate from
 * ACTIVITYPODS_TOKEN, which authorizes federation signing only. ActivityPods
 * also collapses missing-account and wrong-password outcomes to the same 401
 * response and applies account-level abuse controls.
 *
 * Retry: single attempt only. Transient failures are surfaced to the caller;
 * authentication failures are normalized to AUTH_FAILED/401.
 */

import { request } from 'undici';
import type { AtPasswordVerifier, AtSessionContext } from './AtSessionTypes.js';

export interface HttpAtPasswordVerifierConfig {
  /** Base URL of the ActivityPods instance, e.g. http://activitypods:3000 */
  baseUrl: string;
  /** Dedicated bearer token for /api/internal/auth/verify. */
  token: string;
  /** Per-attempt HTTP timeout in milliseconds (default 10 s). */
  timeoutMs?: number;
}

export class HttpAtPasswordVerifier implements AtPasswordVerifier {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: HttpAtPasswordVerifierConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
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
        'content-type': 'application/json',
        'authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ canonicalAccountId, password }),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });

    const body = await res.body.json() as any;

    if (res.statusCode === 200 && body?.ok === true) {
      const scope = body.scope;
      if (scope === 'full' || scope === 'app_password_restricted') {
        return scope;
      }
      throw new Error(`Auth verify: unexpected scope "${scope}"`);
    }

    if (res.statusCode === 401) {
      const err: any = new Error('Auth verify failed');
      err.status = 401;
      err.code = 'AUTH_FAILED';
      throw err;
    }

    throw new Error(`Auth verify failed (HTTP ${res.statusCode})`);
  }
}

/**
 * Resolve the password-verifier capability without permitting the broader
 * federation signing credential to become an auth-verification credential.
 *
 * The production session construction historically passed ACTIVITYPODS_TOKEN
 * as an override. The dedicated environment capability therefore has priority,
 * and an override equal to ACTIVITYPODS_TOKEN is discarded when the dedicated
 * token is absent. Distinct explicit overrides remain available to hermetic
 * tests/embedders. Equal dedicated/federation environment tokens fail closed so
 * an accidental one-token deployment cannot silently defeat capability split.
 */
export function resolveHttpAtPasswordVerifierConfig(
  overrides?: Partial<HttpAtPasswordVerifierConfig>,
  env: NodeJS.ProcessEnv = process.env,
): HttpAtPasswordVerifierConfig {
  const dedicatedToken = env["ATPROTO_PASSWORD_VERIFY_TOKEN"];
  const federationToken = env["ACTIVITYPODS_TOKEN"];
  const overrideToken = overrides?.token;

  if (
    dedicatedToken !== undefined &&
    dedicatedToken.length > 0 &&
    federationToken !== undefined &&
    federationToken.length > 0 &&
    dedicatedToken === federationToken
  ) {
    throw new Error(
      "ATPROTO_PASSWORD_VERIFY_TOKEN must be distinct from ACTIVITYPODS_TOKEN",
    );
  }

  const token = dedicatedToken !== undefined
    ? dedicatedToken
    : overrideToken !== undefined && overrideToken !== federationToken
      ? overrideToken
      : '';

  return {
    baseUrl: overrides?.baseUrl ?? env["ACTIVITYPODS_URL"] ?? 'http://localhost:3000',
    token,
    timeoutMs: overrides?.timeoutMs ?? 10_000,
  };
}

export function createHttpAtPasswordVerifier(
  overrides?: Partial<HttpAtPasswordVerifierConfig>
): HttpAtPasswordVerifier {
  return new HttpAtPasswordVerifier(resolveHttpAtPasswordVerifierConfig(overrides));
}
