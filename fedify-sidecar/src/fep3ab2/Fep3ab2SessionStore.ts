import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  FepSessionMutationEventSchema,
  FepSubscriptionTopicSchema,
  type FepSessionMutationEvent,
  type FepSubscriptionTopic,
} from "./contracts.js";

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
    this.sessionMutationChannel =
      options.sessionMutationChannel ?? `${this.prefix}:session-events`;
  }

  public get ttlSeconds(): number {
    return this.ticketTtlSec;
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
    const raw = await this.redis.smembers(this.topicsKey(sessionId));
    return normalizeTopics(raw);
  }

  public async replaceTopics(sessionId: string, topics: readonly FepSubscriptionTopic[]): Promise<FepSubscriptionTopic[]> {
    const normalized = normalizeTopics(topics);
    const ttl = await this.ensureSessionExists(sessionId);
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
    const tx = this.redis.multi();
    tx.sadd(this.topicsKey(sessionId), ...normalized);
    if (ttl > 0) {
      tx.expire(this.topicsKey(sessionId), ttl);
    }
    await tx.exec();

    const result = await this.listTopics(sessionId);
    await this.publishMutation({
      type: "subscriptions_updated",
      sessionId,
      topics: result,
    });
    return result;
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
