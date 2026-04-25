export interface MRFAuditSink {
  log(event: {
    type: "module.patch" | "chain.patch" | "simulation.create" | "simulation.cancel";
    actor: string;
    requestId: string;
    sourceIp?: string;
    target?: string;
    before?: unknown;
    after?: unknown;
    createdAt: string;
  }): Promise<void>;
}
