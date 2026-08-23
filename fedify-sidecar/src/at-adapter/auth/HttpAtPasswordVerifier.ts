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
 * Resolve the production password-verifier configuration.
 *
 * The credential is intentionally NOT overrideable by callers. This keeps the
 * password-verification capability isolated even if a runtime call site passes
 * a broader ActivityPods credential in a Partial<HttpAtPasswordVerifierConfig>.
 * Only ATPROTO_PASSWORD_VERIFY_TOKEN may authorize /api/internal/auth/verify.
 */
export function resolveHttpAtPasswordVerifierConfig(
  overrides: Partial<HttpAtPasswordVerifierConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): HttpAtPasswordVerifierConfig {
  const safeOverrides = { ...overrides };
  delete safeOverrides.token;

  return {
    baseUrl: env["ACTIVITYPODS_URL"] ?? 'http://localhost:3000',
    timeoutMs: 10_000,
    ...safeOverrides,
    token: env["ATPROTO_PASSWORD_VERIFY_TOKEN"] ?? '',
  };
}

/**
 * Fail closed before the sidecar entrypoint starts when managed XRPC password
 * verification is enabled without its dedicated capability token.
 *
 * `src/index.ts` historically validated ACTIVITYPODS_TOKEN before starting
 * XRPC. That token remains required for other ActivityPods internal APIs, but
 * it must never stand in for the narrower password-verification capability.
 * This preflight executes during entrypoint module loading, before `main()` can
 * create listeners or enter its XRPC initialization catch boundary.
 */
export function assertAtPasswordVerifierRuntimePreflight(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): void {
  const isSidecarEntrypoint = argv.some((argument) =>
    /(?:^|\/)(?:src|dist)\/index\.(?:ts|js)$/u.test(argument),
  );
  if (!isSidecarEntrypoint) return;

  const xrpcEnabled = env["ENABLE_XRPC_SERVER"] !== "false";
  const localFixture = env["AT_LOCAL_FIXTURE"] === "true";
  if (!xrpcEnabled || localFixture) return;

  if (!env["ATPROTO_PASSWORD_VERIFY_TOKEN"]?.trim()) {
    throw new Error(
      "ENABLE_XRPC_SERVER requires ATPROTO_PASSWORD_VERIFY_TOKEN when AT_LOCAL_FIXTURE is false",
    );
  }
}

export function createHttpAtPasswordVerifier(
  overrides?: Partial<HttpAtPasswordVerifierConfig>
): HttpAtPasswordVerifier {
  return new HttpAtPasswordVerifier(
    resolveHttpAtPasswordVerifierConfig(overrides),
  );
}

assertAtPasswordVerifierRuntimePreflight();
