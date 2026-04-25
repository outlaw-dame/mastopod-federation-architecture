import { z } from "zod";
import {
  FepPublishedTopicSchema,
  FepSubscriptionTopicSchema,
  NOTIFICATIONS_TOPIC,
  PERSONAL_FEED_TOPIC,
  Phase1StaticTopicSchema,
  type FepPublishedTopic,
  type FepSubscriptionTopic,
} from "./topics.js";

export {
  Phase1StaticTopicSchema,
  FepPublishedTopicSchema,
  FepSubscriptionTopicSchema,
} from "./topics.js";

export type { FepPublishedTopic, FepSubscriptionTopic } from "./topics.js";

export const FepTopicListSchema = z
  .array(FepSubscriptionTopicSchema)
  .min(1)
  .max(32)
  .refine((topics) => new Set(topics).size === topics.length, {
    message: "topics must not contain duplicates",
  });

export const FepSubscriptionMutationSchema = z.object({
  topics: FepTopicListSchema,
});

export type FepSubscriptionMutation = z.infer<typeof FepSubscriptionMutationSchema>;

export const FepSubscriptionListResponseSchema = z.object({
  topics: z.array(FepSubscriptionTopicSchema),
});

export type FepSubscriptionListResponse = z.infer<typeof FepSubscriptionListResponseSchema>;

export const FepControlSessionResponseSchema = z.object({
  subscriptions_url: z.string().url(),
  stream_url: z.string().url(),
  expires_at: z.string().datetime({ offset: true }),
  wildcard_support: z.boolean().default(false),
});

export type FepControlSessionResponse = z.infer<typeof FepControlSessionResponseSchema>;

export const FepResolvePrincipalResponseSchema = z.object({
  principal: z.string().trim().min(1).max(4096),
  auth_type: z.string().trim().min(1).max(64).optional(),
});

export type FepResolvePrincipalResponse = z.infer<typeof FepResolvePrincipalResponseSchema>;

export const FepDeniedTopicSchema = z.object({
  topic: FepSubscriptionTopicSchema,
  reasonCode: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(512).optional(),
});

export type FepDeniedTopic = z.infer<typeof FepDeniedTopicSchema>;

export const FepAuthorizeTopicsResponseSchema = z.object({
  allowedTopics: z.array(FepSubscriptionTopicSchema),
  deniedTopics: z.array(FepDeniedTopicSchema),
});

export type FepAuthorizeTopicsResponse = z.infer<typeof FepAuthorizeTopicsResponseSchema>;

export const FepSessionMutationEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscriptions_updated"),
    sessionId: z.string().uuid(),
    topics: z.array(FepSubscriptionTopicSchema),
  }),
  z.object({
    type: z.literal("revoked"),
    sessionId: z.string().uuid(),
  }),
]);

export type FepSessionMutationEvent = z.infer<typeof FepSessionMutationEventSchema>;

export const FepPrivateRealtimeMessageSchema = z.object({
  topic: z.union([z.literal(NOTIFICATIONS_TOPIC), z.literal(PERSONAL_FEED_TOPIC)]),
  principal: z.string().trim().min(1).max(4096),
  event: z.union([z.literal("notification"), z.literal("feed")]),
  id: z.string().trim().min(1).max(512).optional(),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export type FepPrivateRealtimeMessage = z.infer<typeof FepPrivateRealtimeMessageSchema>;

export const FepSseEventNameSchema = z.union([
  z.literal("activitypub"),
  z.literal("canonical"),
  z.literal("notification"),
  z.literal("feed"),
  z.literal("heartbeat"),
]);

export type FepSseEventName = z.infer<typeof FepSseEventNameSchema>;

export interface FepReplayEventRecord {
  sequence: number;
  topic: FepPublishedTopic;
  event: FepSseEventName;
  data: Record<string, unknown>;
}

export interface FepDispatchEvent {
  topic: FepPublishedTopic;
  event: FepSseEventName;
  data: Record<string, unknown>;
  id?: string;
  principal?: string;
}
