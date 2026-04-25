import type { StreamEnvelope } from "../feed/DurableStreamContracts.js";
import type { FepDispatchEvent, FepPrivateRealtimeMessage, FepPublishedTopic } from "./contracts.js";
import {
  GLOBAL_FEED_TOPIC,
  LOCAL_FEED_TOPIC,
  collectUriDerivedTopicsFromPayload,
} from "./topics.js";

const PUBLIC_FEED_TOPIC_BY_STREAM: Partial<Record<StreamEnvelope["stream"], FepPublishedTopic>> = {
  stream1: "feeds/public/local",
  stream2: "feeds/public/remote",
  canonical: "feeds/public/canonical",
  unified: "feeds/public/unified",
};

interface FepPublisher {
  publish(event: FepDispatchEvent): void;
}

export class Fep3ab2TopicRouter {
  public constructor(private readonly publisher: FepPublisher) {}

  public handleStreamEnvelope(envelope: StreamEnvelope): void {
    const eventName = envelope.schema.startsWith("canonical.") ? "canonical" : "activitypub";
    const basePayload = {
      stream: envelope.stream,
      schema: envelope.schema,
      occurredAt: envelope.occurredAt,
      payload: envelope.payload,
    };

    const aliasTopic = PUBLIC_FEED_TOPIC_BY_STREAM[envelope.stream];
    if (aliasTopic) {
      this.publish({
        topic: aliasTopic,
        event: eventName,
        id: envelope.eventId,
        data: {
          topic: aliasTopic,
          ...basePayload,
        },
      });
    }

    for (const uriTopic of collectUriDerivedTopicsFromPayload(envelope.payload)) {
      this.publish({
        topic: uriTopic,
        event: eventName,
        id: envelope.eventId,
        data: {
          topic: uriTopic,
          ...basePayload,
        },
      });
    }

    if (envelope.stream === "stream1") {
      this.publish({
        topic: LOCAL_FEED_TOPIC,
        event: "feed",
        id: envelope.eventId,
        data: {
          topic: LOCAL_FEED_TOPIC,
          reason: "refresh_required",
          sourceStream: envelope.stream,
          occurredAt: envelope.occurredAt,
        },
      });
    }

    if (envelope.stream === "unified") {
      this.publish({
        topic: GLOBAL_FEED_TOPIC,
        event: "feed",
        id: envelope.eventId,
        data: {
          topic: GLOBAL_FEED_TOPIC,
          reason: "refresh_required",
          sourceStream: envelope.stream,
          occurredAt: envelope.occurredAt,
        },
      });
    }
  }

  public handlePrivateRealtimeMessage(message: FepPrivateRealtimeMessage): void {
    this.publish({
      topic: message.topic,
      event: message.event,
      id: message.id,
      principal: message.principal,
      data: message.payload,
    });
  }

  private publish(event: FepDispatchEvent): void {
    this.publisher.publish(event);
  }
}
