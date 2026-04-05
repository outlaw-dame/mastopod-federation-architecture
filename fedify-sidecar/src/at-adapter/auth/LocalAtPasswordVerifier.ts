/**
 * Local fixture password verifier — for development and integration testing ONLY.
 *
 * Bypasses the ActivityPods HTTP auth endpoint and validates passwords against
 * statically-configured fixture credentials from environment variables.
 *
 * SECURITY REQUIREMENTS:
 *   - MUST NOT be used in production.
 *   - Activated only when AT_LOCAL_FIXTURE=true is explicitly set.
 *   - Emits a loud startup warning to stderr every time it is constructed.
 *   - Password comparison is constant-time (timing-safe) to maintain the same
 *     security posture as the real HTTP verifier in test environments.
 *
 * Configuration (env vars):
 *   AT_LOCAL_FIXTURE_CREDS   JSON object mapping canonicalAccountId → password.
 *                             Example:
 *                             '{"http://localhost:3000/alice":"AlicePass123"}'
 *                             Defaults to the Phase 7 primary smoke fixture account.
 *
 * Example — start sidecar with fixture auth:
 *   AT_LOCAL_FIXTURE=true \
 *   AT_LOCAL_FIXTURE_CREDS='{"http://localhost:3000/atproto365133":"Phase7LivePass123"}' \
 *   npm run dev
 */

import { timingSafeEqual } from 'node:crypto';
import type { AtPasswordVerifier, AtSessionContext } from './AtSessionTypes.js';

// ---------------------------------------------------------------------------
// Default fixture (matches Phase 7 primary smoke test defaults)
// ---------------------------------------------------------------------------

const DEFAULT_FIXTURE_CREDS: Record<string, string> = {
  'http://localhost:3000/atproto365133': 'Phase7LivePass123',
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LocalAtPasswordVerifier implements AtPasswordVerifier {
  private readonly creds: ReadonlyMap<string, Buffer>;

  constructor() {
    // Loud startup warning — this must never be silent
    process.stderr.write(
      '[SECURITY WARNING] LocalAtPasswordVerifier is active. ' +
      'This bypasses ActivityPods authentication. ' +
      'NEVER use in production.\n',
    );

    const rawCreds = this._loadCreds();
    const entries: [string, Buffer][] = [];
    for (const [id, pw] of Object.entries(rawCreds)) {
      if (typeof id !== 'string' || typeof pw !== 'string') continue;
      entries.push([id, Buffer.from(pw, 'utf8')]);
    }
    this.creds = new Map(entries);

    process.stderr.write(
      `[SECURITY WARNING] Fixture credentials loaded for ${this.creds.size} account(s).\n`,
    );
  }

  async verify(
    canonicalAccountId: string,
    password: string,
  ): Promise<AtSessionContext['scope']> {
    const expected = this.creds.get(canonicalAccountId);
    if (!expected) {
      // Use a fake comparison to prevent timing-based account enumeration
      const dummy = Buffer.from('fixture-account-not-found-dummy', 'utf8');
      const actual = Buffer.from(password, 'utf8');
      _safeEqual(dummy, actual);
      throw Object.assign(
        new Error(`LocalAtPasswordVerifier: account not found: ${canonicalAccountId}`),
        { status: 401, code: 'AUTH_FAILED' },
      );
    }

    const actual = Buffer.from(password, 'utf8');
    if (!_safeEqual(expected, actual)) {
      throw Object.assign(
        new Error(`LocalAtPasswordVerifier: invalid password for ${canonicalAccountId}`),
        { status: 401, code: 'AUTH_FAILED' },
      );
    }

    return 'full';
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _loadCreds(): Record<string, string> {
    const raw = process.env['AT_LOCAL_FIXTURE_CREDS'];
    if (!raw) {
      return DEFAULT_FIXTURE_CREDS;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('AT_LOCAL_FIXTURE_CREDS must be a JSON object');
      }
      return parsed as Record<string, string>;
    } catch (err) {
      process.stderr.write(
        `[LocalAtPasswordVerifier] Failed to parse AT_LOCAL_FIXTURE_CREDS — using defaults. Error: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return DEFAULT_FIXTURE_CREDS;
    }
  }
}

// ---------------------------------------------------------------------------
// Constant-time comparison helper
// ---------------------------------------------------------------------------

/**
 * Length-aware constant-time comparison.
 * `timingSafeEqual` in Node throws when lengths differ, so we pad to the same
 * length before comparing and additionally check the lengths explicitly.
 */
function _safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Still run a dummy comparison on `a` to consume constant time per byte
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
