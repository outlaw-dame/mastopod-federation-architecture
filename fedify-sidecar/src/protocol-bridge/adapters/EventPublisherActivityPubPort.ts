import { createHash } from "node:crypto";
import type { EventPublisher } from "../../core-domain/events/CoreIdentityEvents.js";
import type {
  ActivityPubProjectionCommand,
  ActivityPubPublishPort,
} from "../ports/ProtocolBridgePorts.js";
import {
  type ActivityPubBridgeOutboundDelivery,
  type ActivityPubBridgeIngressEvent,
  type ActivityPubBridgeOutboundEvent,
} from "../events/ActivityPubBridgeEvents.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import { ProtocolBridgeAdapterError } from "./ProtocolBridgeAdapterError.js";
import {
  applyActivityPubOutboundDeliveryPolicy,
  DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
  type ActivityPubOutboundDeliveryPolicy,
} from "../projectors/activitypub/ActivityPubDeliveryPolicy.js";

export interface ActivityPubOutboundResolver {
  resolve(
    command: ActivityPubProjectionCommand,
    activity: Record<string, unknown>,
  ): Promise<ActivityPubBridgeOutboundDelivery[]>;
}

export interface EventPublisherActivityPubPortOptions {
  maxCommandsPerBatch?: number;
  maxActivityBytes?: number;
  now?: () => Date;
  outboundResolver?: ActivityPubOutboundResolver;
  deliveryPolicy?: ActivityPubOutboundDeliveryPolicy;
}

export class EventPublisherActivityPubPort implements ActivityPubPublishPort {
  private readonly maxCommandsPerBatch: number;
  private readonly maxActivityBytes: number;
  private readonly now: () => Date;
  private readonly deliveryPolicy: ActivityPubOutboundDeliveryPolicy;

  public constructor(
    private readonly eventPublisher: EventPublisher,
    private readonly options: EventPublisherActivityPubPortOptions = {},
  ) {
    this.maxCommandsPerBatch = options.maxCommandsPerBatch ?? 8;
    this.maxActivityBytes = options.maxActivityBytes ?? 512_000;
    this.now = options.now ?? (() => new Date());
    this.deliveryPolicy = options.deliveryPolicy ?? DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY;
  }

  public async publish(commands: ActivityPubProjectionCommand[]): Promise<void> {
    if (commands.length === 0) {
      return;
    }
    if (commands.length > this.maxCommandsPerBatch) {
      throw new ProtocolBridgeAdapterError(
        "AP_BRIDGE_BATCH_TOO_LARGE",
        `ActivityPub bridge batch exceeds maximum size ${this.maxCommandsPerBatch}.`,
      );
    }

    for (const command of commands) {
      if (command.kind !== "publishActivity") {
        throw new ProtocolBridgeAdapterError(
          "AP_BRIDGE_COMMAND_INVALID",
          `Unsupported ActivityPub projection command kind: ${command.kind}.`,
        );
      }
      if (!command.metadata) {
        throw new ProtocolBridgeAdapterError(
          "AP_BRIDGE_METADATA_REQUIRED",
          "ActivityPub bridge commands must include provenance metadata.",
        );
      }

      const activity = sanitizeJsonObject(command.activity, {
        maxBytes: this.maxActivityBytes,
      });

      if (command.targetTopic === "ap.atproto-ingress.v1") {
        const actor = extractActor(activity);
        const event: ActivityPubBridgeIngressEvent = {
          version: 1,
          activityId: extractActivityId(activity, command.metadata.canonicalIntentId),
          actor,
          activity,
          bridge: command.metadata,
          receivedAt: this.now().toISOString(),
        };
        await this.eventPublisher.publish(
          command.targetTopic,
          event as any,
          {
            correlationId: command.metadata.canonicalIntentId,
            partitionKey: actor,
            source: "protocol-bridge",
          },
        );
        continue;
      }

      if (!this.options.outboundResolver) {
        throw new ProtocolBridgeAdapterError(
          "AP_OUTBOUND_RECIPIENT_RESOLUTION_REQUIRED",
          "Publishing to ap.outbound.v1 requires an explicit recipient resolver.",
        );
      }

      const deliveries = await this.options.outboundResolver.resolve(command, activity);
      if (deliveries.length === 0) {
        throw new ProtocolBridgeAdapterError(
          "AP_OUTBOUND_RECIPIENTS_EMPTY",
          "Publishing to ap.outbound.v1 requires at least one validated recipient inbox URL.",
        );
      }

      const preparedDeliveries = deliveries.map((delivery) => {
        const actor = cleanNonEmptyString(delivery.actor, "ActivityPub outbound actor is required.");
        const recipients = normalizeRecipients(delivery.recipients);
        if (recipients.length === 0) {
          throw new ProtocolBridgeAdapterError(
            "AP_OUTBOUND_RECIPIENTS_EMPTY",
            "Publishing to ap.outbound.v1 requires at least one validated recipient inbox URL.",
          );
        }

        return {
          actor,
          recipients,
          targetDomain: deriveTargetDomain(delivery, recipients),
          sharedInbox: delivery.sharedInbox,
          jobId: delivery.jobId ?? deriveJobId(command, activity, recipients),
        };
      });

      for (const delivery of preparedDeliveries) {
        const outboundActivity = applyActivityPubOutboundDeliveryPolicy(
          activity,
          delivery.targetDomain,
          command.metadata?.activityPubHints,
          this.deliveryPolicy,
        );
        const event: ActivityPubBridgeOutboundEvent = {
          jobId: delivery.jobId,
          actor: delivery.actor,
          targetDomain: delivery.targetDomain,
          recipients: delivery.recipients,
          sharedInbox: delivery.sharedInbox,
          activity: outboundActivity,
          bridge: command.metadata,
          timestamp: this.now().getTime(),
        };

        await this.eventPublisher.publish(
          command.targetTopic,
          event as any,
          {
            correlationId: command.metadata.canonicalIntentId,
            partitionKey: delivery.targetDomain,
            source: "protocol-bridge",
          },
        );
      }
    }
  }
}

function extractActor(activity: Record<string, unknown>): string {
  const actorValue = activity["actor"];
  if (typeof actorValue === "string" && actorValue.trim().length > 0) {
    return actorValue;
  }
  if (actorValue && typeof actorValue === "object" && !Array.isArray(actorValue)) {
    const nestedId = (actorValue as Record<string, unknown>)["id"];
    if (typeof nestedId === "string" && nestedId.trim().length > 0) {
      return nestedId;
    }
  }

  throw new ProtocolBridgeAdapterError(
    "AP_ACTIVITY_ACTOR_MISSING",
    "Projected ActivityPub activity is missing a string actor identifier.",
  );
}

function extractActivityId(activity: Record<string, unknown>, fallback: string): string {
  const id = activity["id"];
  if (typeof id === "string" && id.trim().length > 0) {
    return id;
  }
  return `urn:bridge:${fallback}`;
}

function deriveJobId(
  command: ActivityPubProjectionCommand,
  activity: Record<string, unknown>,
  recipients: string[],
): string {
  return createHash("sha256")
    .update(`${command.metadata?.canonicalIntentId ?? ""}:${extractActivityId(activity, "activity")}:${recipients.join(",")}`)
    .digest("hex")
    .slice(0, 24);
}

function normalizeRecipients(recipients: string[]): string[] {
  const unique = new Set<string>();
  for (const recipient of recipients) {
    const value = cleanNonEmptyString(recipient, "Outbound recipient URLs must be non-empty strings.");
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ProtocolBridgeAdapterError(
        "AP_OUTBOUND_RECIPIENT_INVALID",
        `Outbound recipient is not a valid URL: ${value}`,
      );
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ProtocolBridgeAdapterError(
        "AP_OUTBOUND_RECIPIENT_INVALID",
        `Outbound recipient must use http or https: ${value}`,
      );
    }
    unique.add(parsed.toString());
  }
  return [...unique];
}

function deriveTargetDomain(
  delivery: ActivityPubBridgeOutboundDelivery,
  recipients: string[],
): string {
  if (typeof delivery.targetDomain === "string" && delivery.targetDomain.trim().length > 0) {
    return delivery.targetDomain.trim().toLowerCase();
  }

  const parsed = new URL(recipients[0]!);
  return parsed.hostname.toLowerCase();
}

function cleanNonEmptyString(value: string, message: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) {
    throw new ProtocolBridgeAdapterError(
      "AP_OUTBOUND_VALUE_INVALID",
      message,
    );
  }
  return cleaned;
}
