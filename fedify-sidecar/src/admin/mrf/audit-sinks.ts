import type { Logger } from "pino";
import type { MRFAuditSink } from "./audit.js";

export class LoggerMRFAuditSink implements MRFAuditSink {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async log(event: {
    type: "module.patch" | "chain.patch" | "simulation.create" | "simulation.cancel";
    actor: string;
    requestId: string;
    sourceIp?: string;
    target?: string;
    before?: unknown;
    after?: unknown;
    createdAt: string;
  }): Promise<void> {
    this.logger.info({ mrfAudit: event }, "MRF admin audit event");
  }
}
