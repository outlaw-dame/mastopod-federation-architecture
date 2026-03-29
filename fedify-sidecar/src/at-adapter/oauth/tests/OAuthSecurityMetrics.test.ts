import { describe, expect, it, beforeEach } from 'vitest';

import {
  incrementOAuthSecurityMetric,
  renderOAuthSecurityMetricsLines,
  resetOAuthSecurityMetricsForTestOnly,
} from '../OAuthSecurityMetrics.js';

describe('OAuth security metrics', () => {
  beforeEach(() => {
    resetOAuthSecurityMetricsForTestOnly();
  });

  it('renders default zero series when no events are recorded', () => {
    const lines = renderOAuthSecurityMetricsLines();
    expect(lines).toContain('fedify_oauth_security_events_total{event="none",outcome="none"} 0');
  });

  it('increments and renders sanitized labels', () => {
    incrementOAuthSecurityMetric({ event: 'oauth.token.exchange', outcome: 'success' });
    incrementOAuthSecurityMetric({ event: 'oauth.token.exchange', outcome: 'success' });
    incrementOAuthSecurityMetric({ event: 'ratelimit.block', outcome: 'denied' });

    const lines = renderOAuthSecurityMetricsLines();
    expect(lines).toContain(
      'fedify_oauth_security_events_total{event="oauth_token_exchange",outcome="success"} 2',
    );
    expect(lines).toContain(
      'fedify_oauth_security_events_total{event="ratelimit_block",outcome="denied"} 1',
    );
  });
});
