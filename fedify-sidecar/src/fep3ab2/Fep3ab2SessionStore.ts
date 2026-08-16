import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  FepSessionMutationEventSchema,
  FepSubscriptionTopicSchema,
  type FepSessionMutationEvent,
  type FepSubscriptionTopic,
} from "./contracts.js";

const DEFAULT_MAX_TOPICS_PER_SESSION = 256;
const MAX_CONFIGURED_TOPICS_PER_SESSION = 4096;
const ADD_TOPICS_BOUNDED_SCRIPT = `
-- fep3ab2:add-topics-bounded:v1
local key = KEYS[1]
local maxTopics = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = redis.call("SCARD", key)

if current > maxTopics then
  return {-2, current}
end

local newCount = 0
for index = 3, #ARGV do
  if redis.call("SISMEMBER", key, ARGV[index]) == 0 then
    newCount = newCount + 1
  end
end

if current + newCount > maxTopics then
  return {-1, current}
end

if #ARGV >= 3 then
  redis.call("SADD", key, unpack(ARGV, 3))
end
if ttl > 0 and redis.call("EXISTS", key) == 1 then
  redis.call("EXPIRE", key, ttl)
end

return {1, current + newCount}
`;

interface PersistedSessionRecord {
  sessionId: string;
  principal: string;
  ticketHash: string;
  createdAt: string;
  expiresAt: string;
  origin?: string;
  userAgentHash?: string;
}

export interface FepResolvedSession {
  sessionId: string;
  principal: string;
  ticketHash: string;
  createdAt: string;
  expiresAt: string;
  topics: FepSubscriptionTopic[];
  origin?: string;
  userAgentHash?: string;
}

export interface FepCreatedSession extends FepResolvedSession {
  ticket: string;
}

export interface FepCreateSessionInput {
  principal: string;
  origin?: string;
  userAgent?: string;
}

export interface FepConsumeSessionConstraints {
  principal?: string;
  origin?: string;
  userAgent?: string;
}

export interface Fep3ab2SessionStoreOptions {
  prefix?: string;
  ticketSecret: string;
  ticketTtlSec?: number;
  maxTopicsPerSession?: number;
  sessionMutationChannel?: string;
}

export class FepSessionStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "FepSessionStoreError";
  }
}

export class Fep3ab2SessionStore {
  private readonly prefix: string;
  private readonly ticketSecret: string;
  private readonly ticketTtlSec: number;
  private readonly maxTopicsPerSession: number;
  private readonly sessionMutationChannel: string;

  public constructor(
    private readonly redis: Redis,
    options: Fep3ab2SessionStoreOptions,
  ) {
    if (!options.ticketSecret.trim()) {
      throw new Error("Fep3ab2SessionStore requires a non-empty ticket secret");
    }

    this.prefix = options.prefix ?? "fep3ab2";
    this.ticketSecret = options.ticketSecret;
    this.ticketTtlSec = Math.max(60, Math.min(options.ticketTtlSec ?? 900, 3600));
    this.maxTopicsPerSession = normalizeTopicLimit(options.maxTopicsPerSession);
    this.sessionMutationChannel =
      options.sessionMutationChannel ?? `${this.prefix}:session-events`;
  }

  public get ttlSeconds(): number {
    return this.ticketTtlSec;
  }

  public get topicLimit(): number {
    return this.maxTopicsPerSession;
  }

  public get mutationChannel(): string {
    return this.sessionMutationChannel;
  }

  public async createSession(input: FepCreateSessionInput): Promise<FepCreatedSession> {
    const principal = normalizePrincipal(input.principal);
    if (!principal) {
      throw new FepSessionStoreError("principal is required", "invalid_principal", 400);
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.ticketTtlSec * 1000);
    const sessionId = randomUUID();
    const ticket = randomBytes(32).toString("base64url");
    const ticketHash = this.hashTicket(ticket);

    const record: PersistedSessionRecord = {
      sessionId,
      principal,
      ticketHash,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      origin: sanitizeOrigin(input.origin),
      userAgentHash: hashUserAgent(input.userAgent),
    };

    await this.redis
      .multi()
      .set(this.sessionKey(sessionId), JSON.stringify(record), "EX", this.ticketTtlSec)
      .set(this.ticketKey(ticketHash), sessionId, "EX", this.ticketTtlSec)
      .exec();

    return {
      ...record,
      topics: [],
      ticket,
    };
  }

  public async loadControlSession(ticket: string, principal: string): Promise<FepResolvedSession> {
    const session = await this.resolveSession(ticket);
    if (!session) {
      throw new FepSessionStoreError("Streaming ticket is missing or expired", "invalid_ticket", 401);
    }

    if (session.principal !== normalizePrincipal(principal)) {
      throw new FepSessionStoreError("Streaming ticket does not belong to the authenticated principal", "invalid_ticket", 401);
    }

    return session;
  }

  public async consumeStreamTicket(
    ticket: string,
    constraints?: FepConsumeSessionConstraints,
  ): Promise<FepResolvedSession> {
    const session = await this.resolveSession(ticket);
    if (!session) {
      throw new FepSessionStoreError("Streaming ticket is missing or expired", "invalid_ticket", 401);
    }

    validateSessionConstraints(session, constraints);

    const ttlSeconds = Math.max(
      1,
      Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000),
    );

    const claimResult = await this.redis.set(
      this.consumedKey(session.ticketHash),
      session.sessionId,
      "EX",
      ttlSeconds,
      "NX",
    );
    if (claimResult !== "OK") {
      throw new FepSessionStoreError("Streaming ticket has already been used", "ticket_already_used", 409);
    }

    return session;
  }

  public async listTopics(sessionId: string): Promise<FepSubscriptionTopic[]> {
    await this.ensureSessionExists(sessionId);
    const topicCount = await this.redis.scard(this.topicsKey(sessionId));
    this.assertTopicCountWithinLimit(topicCount);
    const raw = await this.redis.smembers(this.topicsKey(sessionId));
    this.assertTopicCountWithinLimit(raw.length);
    return normalizeTopics(raw);
  }

  public async replaceTopics(sessionId: string, topics: readonly FepSubscriptionTopic[]): Promise<FepSubscriptionTopic[]> {
    const normalized = normalizeTopics(topics);
    const ttl = await this.ensureSessionExists(sessionId);
    this.assertTopicCountWithinLimit(normalized.length);
    const tx = this.redis.multi();
    tx.del(this.topicsKey(sessionId));
    if (normalized.length > 0) {
      tx.sadd(this.topicsKey(sessionId), ...normalized);
      if (ttl > 0) {
        tx.expire(this.topicsKey(sessionId), ttl);
      }
    }
    await tx.exec();
    await this.publishMutation({
      type: "subscriptions_updated",
      sessionId,
      topics: normalized,
    });
    return normalized;
  }

  public async addTopics(sessionId: string, topics: readonly FepSubscriptionTopic[]): Promise<FepSubscriptionTopic[]> {
    const normalized = normalizeTopics(topics);
    if (normalized.length === 0) {
      return this.listTopics(sessionId);
    }

    const ttl = await this.ensureSessionExists(sessionId);
    this.assertTopicCountWithinLimit(normalized.length);
    const rawResult = await this.redis.eval(
      ADD_TOPICS_BOUNDED_SCRIPT,
      1,
      this.topicsKey(sessionId),
      this.maxTopicsPerSession,
      ttl,
      ...normalized,
    );
    const result = Array.isArray(rawResult) ? rawResult : [];
    const status = Number(result[0]);
    const observedCount = Number(result[1]);
    if (status !== 1) {
      throw this.topicLimitError(Number.isFinite(observedCount) ? observedCount : undefined);
    }

    const topicsAfterAdd = await this.listTopics(sessionId);
    await this.publishMutation({
      type: "subscriptions_updated",
      sessionId,
      topics: topicsAfterAdd,
    });
    return topicsAfterAdd;
  }

  public async removeTopic(sessionId: string, topic: FepSubscriptionTopic): Promise<FepSubscriptionTopic[]> {
    await this.ensureSessionExists(sessionId);
    await this.redis.srem(this.topicsKey(sessionId), topic);
    const result = await this.listTopics(sessionId);
    await this.publishMutation({
      type: "subscriptions_updated",
      sessionId,
      topics: result,
    });
    return result;
  }

  public async revokeByTicket(ticket: string, principal?: string): Promise<void> {
    const session = await this.resolveSession(ticket);
    if (!session) {
      return;
    }

    if (principal && session.principal !== normalizePrincipal(principal)) {
      throw new FepSessionStoreError("Streaming ticket does not belong to the authenticated principal", "invalid_ticket", 401);
    }

    await this.redis
      .multi()
      .del(this.sessionKey(session.sessionId))
      .del(this.ticketKey(session.ticketHash))
      .del(this.topicsKey(session.sessionId))
      .del(this.consumedKey(session.ticketHash))
      .exec();

    await this.publishMutation({
      type: "revoked",
      sessionId: session.sessionId,
    });
  }

  public hashTicket(ticket: string): string {
    return createHmac("sha256", this.ticketSecret)
      .update(ticket, "utf8")
      .digest("hex");
  }

  private async resolveSession(ticket: string): Promise<FepResolvedSession | null> {
    const normalizedTicket = normalizeTicket(ticket);
    if (!normalizedTicket) {
      return null;
    }

    const ticketHash = this.hashTicket(normalizedTicket);
    const sessionId = await this.redis.get(this.ticketKey(ticketHash));
    if (!sessionId) {
      return null;
    }

    const raw = await this.redis.get(this.sessionKey(sessionId));
    if (!raw) {
      await this.redis.del(this.ticketKey(ticketHash));
      return null;
    }

    let parsed: PersistedSessionRecord | null = null;
    try {
      parsed = JSON.parse(raw) as PersistedSessionRecord;
    } catch {
      parsed = null;
    }

    if (!parsed || parsed.ticketHash !== ticketHash || parsed.sessionId !== sessionId) {
      return null;
    }

    const expiresAtMs = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }

    const topics = await this.listTopics(parsed.sessionId);
    return {
      ...parsed,
      topics,
    };
  }

  private async publishMutation(event: FepSessionMutationEvent): Promise<void> {
    const validated = FepSessionMutationEventSchema.parse(event);
    await this.redis.publish(this.sessionMutationChannel, JSON.stringify(validated));
  }

  private async ensureSessionExists(sessionId: string): Promise<number> {
    const ttl = await this.redis.ttl(this.sessionKey(sessionId));
    if (ttl === -2) {
      throw new FepSessionStoreError("Streaming ticket is missing or expired", "invalid_ticket", 401);
    }
    return ttl;
  }

  private assertTopicCountWithinLimit(topicCount: number): void {
    if (!Number.isSafeInteger(topicCount) || topicCount < 0 || topicCount > this.maxTopicsPerSession) {
      throw this.topicLimitError(Number.isSafeInteger(topicCount) && topicCount >= 0 ? topicCount : undefined);
    }
  }

  private topicLimitError(observedCount?: number): FepSessionStoreError {
    const suffix = observedCount === undefined ? "" : ` (observed ${observedCount})`;
    return new FepSessionStoreError(
      `Streaming session topic limit of ${this.maxTopicsPerSession} exceeded${suffix}`,
      "topic_limit_exceeded",
      409,
    );
  }

  private sessionKey(sessionId: string): string {
    return `${this.prefix}:session:${sessionId}`;
  }

  private ticketKey(ticketHash: string): string {
    return `${this.prefix}:ticket:${ticketHash}`;
  }

  private topicsKey(sessionId: string): string {
    return `${this.prefix}:session:${sessionId}:topics`;
  }

  private consumedKey(ticketHash: string): string {
    return `${this.prefix}:ticket-consumed:${ticketHash}`;
  }
}

function normalizeTopicLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_TOPICS_PER_SESSION;
  }
  return Math.max(1, Math.min(Math.floor(value as number), MAX_CONFIGURED_TOPICS_PER_SESSION));
}

function normalizePrincipal(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096) {
    return null;
  }
  return normalized;
}

function normalizeTicket(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024) {
    return null;
  }
  return normalized;
}

function normalizeTopics(topics: readonly string[]): FepSubscriptionTopic[] {
  return Array.from(new Set(topics))
    .map((topic) => FepSubscriptionTopicSchema.safeParse(topic))
    .filter((result): result is { success: true; data: FepSubscriptionTopic } => result.success)
    .map((result) => result.data)
    .sort();
}

function sanitizeOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    return undefined;
  }
  return normalized;
}

function hashUserAgent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized.slice(0, 1024), "utf8").digest("hex");
}

function validateSessionConstraints(
  session: FepResolvedSession,
  constraints: FepConsumeSessionConstraints | undefined,
): void {
  if (!constraints) {
    return;
  }

  if (constraints.principal && session.principal !== normalizePrincipal(constraints.principal)) {
    throw new FepSessionStoreError(
      "Streaming ticket does not belong to the authenticated principal",
      "invalid_ticket",
      401,
    );
  }

  const expectedOrigin = sanitizeOrigin(constraints.origin);
  if (session.origin && expectedOrigin && session.origin !== expectedOrigin) {
    throw new FepSessionStoreError(
      "Streaming ticket origin binding does not match the current request origin",
      "origin_mismatch",
      401,
    );
  }

  const expectedUserAgentHash = hashUserAgent(constraints.userAgent);
  if (session.userAgentHash && expectedUserAgentHash && session.userAgentHash !== expectedUserAgentHash) {
    throw new FepSessionStoreError(
      "Streaming ticket user-agent binding does not match the current request",
      "user_agent_mismatch",
      401,
    );
  }
}
