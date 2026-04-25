import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIdentitySyncTraceEnabled, traceIdentitySync } from '../identity/IdentitySyncTrace.js';

describe('traceIdentitySync', () => {
  afterEach(() => {
    delete process.env['IDENTITY_SYNC_TRACE'];
  });

  it('emits structured metadata before the message for pino-compatible loggers', () => {
    process.env['IDENTITY_SYNC_TRACE'] = 'true';
    const info = vi.fn();

    traceIdentitySync(
      {
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
      },
      'info',
      'resolver:retry-hit',
      {
        canonicalAccountId: 'acct-1',
        did: 'did:plc:alice',
      }
    );

    expect(info).toHaveBeenCalledWith(
      {
        canonicalAccountId: 'acct-1',
        did: 'did:plc:alice',
      },
      '[identity-sync] resolver:retry-hit'
    );
  });

  it('does nothing when identity sync tracing is disabled', () => {
    const info = vi.fn();

    traceIdentitySync(
      {
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
      },
      'info',
      'resolver:retry-hit',
      {
        canonicalAccountId: 'acct-1',
      }
    );

    expect(isIdentitySyncTraceEnabled()).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});
