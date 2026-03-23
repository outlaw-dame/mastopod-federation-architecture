/**
 * V6 Event Log Topology (RedPanda)
 * 
 * Defines the canonical V6 topic structure for ActivityPub federation events.
 * RedPanda is used ONLY as an immutable append-only event log, never as a work queue.
 * 
 * Topics:
 * - ap.stream1.local-public.v1: Local public activities (from ActivityPods outbox)
 * - ap.stream2.remote-public.v1: Remote public activities (post-verification)
 * - ap.firehose.v1: Combined public activity stream (for indexing)
 * - ap.outbound.v1: Outbound delivery readiness events (from ActivityPods)
 * - ap.inbound.v1: Inbound activity events (before MRF processing)
 * - ap.mrf.rejected.v1: MRF rejection audit trail
 */

export interface V6TopologyConfig {
  brokers: string[];
  clientId: string;
  compression: 'snappy' | 'gzip' | 'zstd' | 'lz4' | 'none';
}

export interface TopicSchema {
  name: string;
  partitions: number;
  replicationFactor: number;
  retentionMs: number;
  description: string;
}

/**
 * V6 Topic Definitions
 */
export const V6_TOPICS: Record<string, TopicSchema> = {
  // Local public activities from ActivityPods outbox
  'ap.stream1.local-public.v1': {
    name: 'ap.stream1.local-public.v1',
    partitions: 3,
    replicationFactor: 3,
    retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    description: 'Local public activities from ActivityPods outbox',
  },

  // Remote public activities (post-verification by sidecar)
  'ap.stream2.remote-public.v1': {
    name: 'ap.stream2.remote-public.v1',
    partitions: 3,
    replicationFactor: 3,
    retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    description: 'Remote public activities (post-HTTP signature verification)',
  },

  // Combined public activity stream for indexing/search
  'ap.firehose.v1': {
    name: 'ap.firehose.v1',
    partitions: 1,
    replicationFactor: 3,
    retentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    description: 'Combined public activity stream (Stream1 + Stream2 + tombstones)',
  },

  // Outbound delivery readiness events from ActivityPods
  'ap.outbound.v1': {
    name: 'ap.outbound.v1',
    partitions: 3,
    replicationFactor: 3,
    retentionMs: 24 * 60 * 60 * 1000, // 24 hours
    description: 'Outbound delivery readiness events (sidecar consumes for delivery)',
  },

  // Inbound activity events (before MRF processing)
  'ap.inbound.v1': {
    name: 'ap.inbound.v1',
    partitions: 3,
    replicationFactor: 3,
    retentionMs: 24 * 60 * 60 * 1000, // 24 hours
    description: 'Inbound activity events (before MRF processing)',
  },

  // MRF rejection audit trail
  'ap.mrf.rejected.v1': {
    name: 'ap.mrf.rejected.v1',
    partitions: 1,
    replicationFactor: 3,
    retentionMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    description: 'MRF rejection audit trail (for compliance and debugging)',
  },

  // Tombstone events (deletes)
  'ap.tombstones.v1': {
    name: 'ap.tombstones.v1',
    partitions: 1,
    replicationFactor: 3,
    retentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    description: 'Tombstone events (delete notifications)',
  },
};

/**
 * Event schemas for each topic
 */
export interface Stream1Event {
  // Local public activity
  activityId: string;
  activityType: string;
  actor: string;
  object?: any;
  published: string;
  to?: string[];
  cc?: string[];
  content?: string;
  inReplyTo?: string;
  timestamp: number;
}

export interface Stream2Event {
  // Remote public activity (post-verification)
  activityId: string;
  activityType: string;
  actor: string;
  object?: any;
  published: string;
  to?: string[];
  cc?: string[];
  content?: string;
  inReplyTo?: string;
  verifiedAt: number;
  remoteIp: string;
  timestamp: number;
}

export interface FirehoseEvent {
  // Combined public activity
  origin: 'local' | 'remote';
  activityId: string;
  activityType: string;
  actor: string;
  object?: any;
  published: string;
  to?: string[];
  cc?: string[];
  content?: string;
  inReplyTo?: string;
  timestamp: number;
}

export interface OutboundEvent {
  // Outbound delivery readiness
  jobId: string;
  actor: string;
  activity: any;
  recipients: string[];
  sharedInbox?: string;
  timestamp: number;
}

export interface InboundEvent {
  // Inbound activity (before MRF)
  activityId: string;
  activity: any;
  actor: string;
  remoteIp: string;
  timestamp: number;
}

export interface MrfRejectionEvent {
  // MRF rejection audit
  jobId: string;
  activity: any;
  actor: string;
  reason: string;
  policy: string;
  timestamp: number;
}

export interface TombstoneEvent {
  // Delete notification
  objectId: string;
  deletedAt: string;
  timestamp: number;
}

/**
 * Get topic configuration
 */
export function getTopicConfig(topicName: string): TopicSchema | null {
  return V6_TOPICS[topicName] || null;
}

/**
 * Get all topic names
 */
export function getAllTopicNames(): string[] {
  return Object.keys(V6_TOPICS);
}

/**
 * Validate topic name against V6 spec
 */
export function isValidTopicName(name: string): boolean {
  return name in V6_TOPICS;
}

/**
 * Get topic retention period in milliseconds
 */
export function getTopicRetention(topicName: string): number {
  const topic = getTopicConfig(topicName);
  return topic?.retentionMs || 0;
}

/**
 * Create default topology configuration
 */
export function createDefaultTopologyConfig(): V6TopologyConfig {
  return {
    brokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.REDPANDA_CLIENT_ID || 'fedify-sidecar-v6',
    compression: (process.env.REDPANDA_COMPRESSION || 'zstd') as any,
  };
}
