import {
  CanonicalReportEventConsumer,
  type CanonicalReportEventConsumerConfig,
  type CanonicalReportEventConsumerLogger,
} from "./CanonicalReportEventConsumer.js";
import {
  AtprotoReportForwardingService,
  type AtprotoReportForwardingLogger,
} from "./AtprotoReportForwardingService.js";

export interface CanonicalAtprotoReportForwarderConfig extends Omit<CanonicalReportEventConsumerConfig, "consumerName"> {}

const NOOP_LOGGER: AtprotoReportForwardingLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class CanonicalAtprotoReportForwarder {
  private readonly consumer: CanonicalReportEventConsumer;

  constructor(
    config: CanonicalAtprotoReportForwarderConfig,
    forwardingService: AtprotoReportForwardingService,
    logger: AtprotoReportForwardingLogger = NOOP_LOGGER,
  ) {
    this.consumer = new CanonicalReportEventConsumer(
      {
        ...config,
        consumerName: "canonical-atproto-report-forwarder",
      },
      forwardingService,
      logger satisfies CanonicalReportEventConsumerLogger,
    );
  }

  start(): Promise<void> {
    return this.consumer.start();
  }

  stop(): Promise<void> {
    return this.consumer.stop();
  }
}
