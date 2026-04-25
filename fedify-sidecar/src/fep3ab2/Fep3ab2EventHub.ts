import { metrics } from "../metrics/index.js";
import {
  type FepDispatchEvent,
  type FepSseEventName,
  type FepSubscriptionTopic,
} from "./contracts.js";
import { classifyTopicForMetrics, topicMatches } from "./topics.js";

export interface FepRegisterConnectionInput {
  sessionId: string;
  principal: string;
  topics: readonly FepSubscriptionTopic[];
  expiresAt: string;
  paused?: boolean;
  maxBufferedEvents?: number;
  send: (event: FepSseEventName, data: string, id?: string) => boolean;
  close: (reason?: string) => void;
}

interface BufferedDispatchEvent {
  event: FepSseEventName;
  data: string;
  id?: string;
  topicGroup: string;
}

interface FepConnectionHandle {
  sessionId: string;
  principal: string;
  topics: Set<FepSubscriptionTopic>;
  expiresAtMs: number;
  paused: boolean;
  maxBufferedEvents: number;
  bufferedEvents: BufferedDispatchEvent[];
  send: (event: FepSseEventName, data: string, id?: string) => boolean;
  close: (reason?: string) => void;
}

export class Fep3ab2EventHub {
  private readonly connections = new Map<string, FepConnectionHandle>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(private readonly heartbeatIntervalMs: number = 20_000) {}

  public start(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, connection] of this.connections) {
        if (connection.expiresAtMs <= now) {
          this.closeSession(sessionId, "expired");
          continue;
        }

        const sent = connection.send(
          "heartbeat",
          JSON.stringify({ occurredAt: new Date(now).toISOString() }),
        );
        if (!sent) {
          this.closeSession(sessionId, "stream_send_failed");
        }
      }
    }, this.heartbeatIntervalMs);

    this.heartbeatTimer.unref?.();
  }

  public shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const sessionId of this.connections.keys()) {
      this.closeSession(sessionId, "shutdown");
    }
  }

  public registerConnection(input: FepRegisterConnectionInput): () => void {
    const expiresAtMs = Date.parse(input.expiresAt);
    const handle: FepConnectionHandle = {
      sessionId: input.sessionId,
      principal: input.principal,
      topics: new Set(input.topics),
      expiresAtMs,
      paused: input.paused === true,
      maxBufferedEvents: Math.max(32, Math.min(input.maxBufferedEvents ?? 512, 4096)),
      bufferedEvents: [],
      send: input.send,
      close: input.close,
    };
    this.connections.set(input.sessionId, handle);
    metrics.fepStreamingActiveConnections.inc();
    return () => {
      this.unregisterConnection(input.sessionId);
    };
  }

  public publish(event: FepDispatchEvent): void {
    const payload = JSON.stringify(event.data);

    for (const [sessionId, connection] of this.connections) {
      if (event.principal && connection.principal !== event.principal) {
        continue;
      }
      if (![...connection.topics].some((subscription) => topicMatches(subscription, event.topic))) {
        continue;
      }

      const topicGroup = classifyTopicForMetrics(event.topic);
      if (connection.paused) {
        if (connection.bufferedEvents.length >= connection.maxBufferedEvents) {
          this.closeSession(sessionId, "replay_buffer_overflow");
          continue;
        }
        connection.bufferedEvents.push({
          event: event.event,
          data: payload,
          id: event.id,
          topicGroup,
        });
        continue;
      }

      const sent = connection.send(event.event, payload, event.id);
      if (!sent) {
        this.closeSession(sessionId, "stream_send_failed");
        continue;
      }
      metrics.fepStreamingEventsPublished.inc({ topic_group: topicGroup, event: event.event });
    }
  }

  public updateSessionTopics(sessionId: string, topics: readonly FepSubscriptionTopic[]): void {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }
    connection.topics = new Set(topics);
  }

  public resumeSession(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }

    connection.paused = false;
    const buffered = connection.bufferedEvents.splice(0, connection.bufferedEvents.length);
    for (const event of buffered) {
      const sent = connection.send(event.event, event.data, event.id);
      if (!sent) {
        this.closeSession(sessionId, "stream_send_failed");
        return;
      }
      metrics.fepStreamingEventsPublished.inc({ topic_group: event.topicGroup, event: event.event });
    }
  }

  public closeSession(sessionId: string, reason?: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }
    this.connections.delete(sessionId);
    metrics.fepStreamingActiveConnections.dec();
    try {
      connection.close(reason);
    } catch {
      // best effort
    }
  }

  private unregisterConnection(sessionId: string): void {
    const existing = this.connections.get(sessionId);
    if (!existing) {
      return;
    }
    this.connections.delete(sessionId);
    metrics.fepStreamingActiveConnections.dec();
  }
}
