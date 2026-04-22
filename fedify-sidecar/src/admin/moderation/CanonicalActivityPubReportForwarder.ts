import {
  CanonicalReportEventConsumer,
  type CanonicalReportEventConsumerConfig,
  type CanonicalReportEventConsumerLogger,
} from "./CanonicalReportEventConsumer.js";
import {
  ActivityPubReportForwardingService,
  type ActivityPubReportForwardingLogger,
} from "./ActivityPubReportForwardingService.js";

export interface CanonicalActivityPubReportForwarderConfig extends Omit<CanonicalReportEventConsumerConfig, "consumerName"> {}

const NOOP_LOGGER: ActivityPubReportForwardingLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class CanonicalActivityPubReportForwarder {
  private readonly consumer: CanonicalReportEventConsumer;

  constructor(
    config: CanonicalActivityPubReportForwarderConfig,
    forwardingService: ActivityPubReportForwardingService,
    logger: ActivityPubReportForwardingLogger = NOOP_LOGGER,
  ) {
    this.consumer = new CanonicalReportEventConsumer(
      {
        ...config,
        consumerName: "canonical-ap-report-forwarder",
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
