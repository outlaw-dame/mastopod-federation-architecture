type Inputs = {
  inboundConcurrency: number;
  outboundConcurrency: number;
  maxConcurrentPerDomain: number;
  inboundP95Ms: number;
  outboundP95Ms: number;
  websocketConnections: number;
  websocketMsgPerSecPerConn: number;
};

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function perSecond(concurrency: number, p95Ms: number): number {
  return concurrency / (p95Ms / 1000);
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function main() {
  const input: Inputs = {
    inboundConcurrency: readNumber('INBOUND_CONCURRENCY', 32),
    outboundConcurrency: readNumber('OUTBOUND_CONCURRENCY', 64),
    maxConcurrentPerDomain: readNumber('MAX_CONCURRENT_PER_DOMAIN', 10),
    inboundP95Ms: readNumber('INBOUND_P95_MS', 250),
    outboundP95Ms: readNumber('OUTBOUND_P95_MS', 1500),
    websocketConnections: readNumber('WS_CONNECTIONS', 5000),
    websocketMsgPerSecPerConn: readNumber('WS_MSG_PER_SEC_PER_CONN', 0.05),
  };

  const inboundReqPerSec = perSecond(input.inboundConcurrency, input.inboundP95Ms);
  const outboundReqPerSec = perSecond(input.outboundConcurrency, input.outboundP95Ms);
  const outboundPerDomainReqPerSec = perSecond(input.maxConcurrentPerDomain, input.outboundP95Ms);
  const websocketMessagesPerSec = input.websocketConnections * input.websocketMsgPerSecPerConn;

  const report = {
    assumptions: input,
    estimatedCapacity: {
      inboundRequestsPerSecond: Number(fmt(inboundReqPerSec)),
      outboundDeliveriesPerSecond: Number(fmt(outboundReqPerSec)),
      outboundPerDomainDeliveriesPerSecond: Number(fmt(outboundPerDomainReqPerSec)),
      websocketMessagesPerSecond: Number(fmt(websocketMessagesPerSec)),
    },
    notes: [
      'These are queue-worker and connection-envelope estimates, not end-to-end SLA guarantees.',
      'Use loadtest:k6 scripts plus /metrics to validate real-world capacity under burst and sustained load.',
      'If queue lag grows while concurrency is near max, scale nodes or increase concurrency bounds carefully.',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
