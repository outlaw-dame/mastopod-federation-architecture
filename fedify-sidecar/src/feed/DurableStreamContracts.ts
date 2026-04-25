import { z } from "zod";
import { FeedSourceSchema, IsoDateTimeSchema, OpaqueIdentifierSchema, ViewerIdSchema } from "./contracts.js";

export const DurableTransportSchema = z.enum(["sse", "websocket"]);
export type DurableTransport = z.infer<typeof DurableTransportSchema>;

export const DurableStreamSchema = FeedSourceSchema;
export type DurableStreamName = z.infer<typeof DurableStreamSchema>;

export const StreamSubscriptionFiltersSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  langs: z.array(z.string().trim().min(1).max(16)).max(16).optional(),
  authors: z.array(z.string().trim().min(1).max(2048)).max(64).optional(),
  objectTypes: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
}).strict();

export const StreamSubscriptionRequestSchema = z.object({
  transport: DurableTransportSchema,
  streams: z.array(DurableStreamSchema).min(1).max(4).refine((value) => new Set(value).size === value.length, {
    message: "streams must not contain duplicates",
  }),
  viewerId: ViewerIdSchema.optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  filters: StreamSubscriptionFiltersSchema.optional(),
});

export const StreamEnvelopeSchema = z.object({
  stream: DurableStreamSchema,
  eventId: OpaqueIdentifierSchema,
  cursor: z.string().trim().min(1).max(512),
  occurredAt: IsoDateTimeSchema,
  schema: z.string().trim().min(1).max(128),
  payload: z.unknown(),
});

export const DurableStreamCapabilitySchema = z.object({
  stream: DurableStreamSchema,
  supportsSse: z.boolean(),
  supportsWebSocket: z.boolean(),
  requiresAuthentication: z.boolean(),
  replayCapable: z.boolean(),
});

export type StreamSubscriptionRequest = z.infer<typeof StreamSubscriptionRequestSchema>;
export type StreamEnvelope = z.infer<typeof StreamEnvelopeSchema>;
export type DurableStreamCapability = z.infer<typeof DurableStreamCapabilitySchema>;
