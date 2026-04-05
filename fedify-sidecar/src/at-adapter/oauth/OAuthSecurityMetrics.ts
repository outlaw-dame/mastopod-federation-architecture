interface OAuthSecurityMetricKey {
  event: string;
  outcome: 'success' | 'denied' | 'failure';
}

const counters = new Map<string, number>();

function keyToString(key: OAuthSecurityMetricKey): string {
  return `${key.event}|${key.outcome}`;
}

function sanitizePromLabel(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '_');
  return compact || 'unknown';
}

export function incrementOAuthSecurityMetric(key: OAuthSecurityMetricKey): void {
  const mapKey = keyToString(key);
  counters.set(mapKey, (counters.get(mapKey) ?? 0) + 1);
}

export function renderOAuthSecurityMetricsLines(): string[] {
  const lines: string[] = [
    '# HELP fedify_oauth_security_events_total Count of OAuth security-relevant events by type and outcome',
    '# TYPE fedify_oauth_security_events_total counter',
  ];

  for (const [mapKey, count] of counters.entries()) {
    const [event, outcome] = mapKey.split('|');
    const safeEvent = sanitizePromLabel(event ?? 'unknown');
    const safeOutcome = sanitizePromLabel(outcome ?? 'unknown');
    lines.push(`fedify_oauth_security_events_total{event="${safeEvent}",outcome="${safeOutcome}"} ${count}`);
  }

  if (counters.size === 0) {
    lines.push('fedify_oauth_security_events_total{event="none",outcome="none"} 0');
  }

  return lines;
}

export function resetOAuthSecurityMetricsForTestOnly(): void {
  counters.clear();
}
