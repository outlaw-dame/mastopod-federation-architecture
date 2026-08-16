import { describe, expect, it, vi } from "vitest";
import { Fep3ab2SessionStore, FepSessionStoreError } from "../Fep3ab2SessionStore.js";
import { MemoryRedis } from "./MemoryRedis.js";

const PRINCIPAL = "https://example.com/users/alice";
const TOPIC_A = "feeds/public/local";
const TOPIC_B = "feeds/public/remote";
const TOPIC_C = "feeds/public/unified";

describe("Fep3ab2SessionStore", () => {
  it("creates, loads, consumes, and revokes a session ticket", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      ticketTtlSec: 300,
    });

    const created = await store.createSession({
      principal: PRINCIPAL,
      origin: "https://app.example",
      userAgent: "test-agent",
    });

    expect(created.ticket.length).toBeGreaterThan(20);
    expect(created.topics).toEqual([]);

    const loaded = await store.loadControlSession(
      created.ticket,
      PRINCIPAL,
    );
    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.principal).toBe(PRINCIPAL);

    const topics = await store.addTopics(created.sessionId, [
      "feeds/public/local",
      "server.example/note/#",
    ]);
    expect(topics).toEqual(["feeds/public/local", "server.example/note/#"]);

    const consumed = await store.consumeStreamTicket(created.ticket, {
      principal: PRINCIPAL,
      origin: "https://app.example",
      userAgent: "test-agent",
    });
    expect(consumed.sessionId).toBe(created.sessionId);
    expect(consumed.topics).toEqual(["feeds/public/local", "server.example/note/#"]);

    await expect(store.consumeStreamTicket(created.ticket)).rejects.toMatchObject({
      code: "ticket_already_used",
      statusCode: 409,
    } satisfies Partial<FepSessionStoreError>);

    await store.revokeByTicket(created.ticket, PRINCIPAL);

    await expect(
      store.loadControlSession(created.ticket, PRINCIPAL),
    ).rejects.toMatchObject({
      code: "invalid_ticket",
      statusCode: 401,
    } satisfies Partial<FepSessionStoreError>);
  });

  it("does not consume a ticket when the principal binding does not match", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      ticketTtlSec: 300,
    });

    const created = await store.createSession({
      principal: PRINCIPAL,
      origin: "https://app.example",
      userAgent: "test-agent",
    });

    await expect(store.consumeStreamTicket(created.ticket, {
      principal: "https://example.com/users/bob",
      origin: "https://app.example",
      userAgent: "test-agent",
    })).rejects.toMatchObject({
      code: "invalid_ticket",
      statusCode: 401,
    } satisfies Partial<FepSessionStoreError>);

    const stillLoadable = await store.loadControlSession(
      created.ticket,
      PRINCIPAL,
    );
    expect(stillLoadable.sessionId).toBe(created.sessionId);
  });

  it("enforces the cumulative topic cap without mutating the accepted set", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      ticketTtlSec: 300,
      maxTopicsPerSession: 2,
    });
    const created = await store.createSession({ principal: PRINCIPAL });

    await expect(store.addTopics(created.sessionId, [TOPIC_A, TOPIC_B])).resolves.toEqual([
      TOPIC_A,
      TOPIC_B,
    ]);
    await expect(store.addTopics(created.sessionId, [TOPIC_C])).rejects.toMatchObject({
      code: "topic_limit_exceeded",
      statusCode: 409,
      retryable: false,
    } satisfies Partial<FepSessionStoreError>);
    await expect(store.listTopics(created.sessionId)).resolves.toEqual([TOPIC_A, TOPIC_B]);
  });

  it("does not charge duplicate topics against remaining capacity", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      maxTopicsPerSession: 2,
    });
    const created = await store.createSession({ principal: PRINCIPAL });

    await store.addTopics(created.sessionId, [TOPIC_A]);
    await expect(store.addTopics(created.sessionId, [TOPIC_A, TOPIC_B])).resolves.toEqual([
      TOPIC_A,
      TOPIC_B,
    ]);
  });

  it("atomically prevents concurrent additions from exceeding the session cap", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      maxTopicsPerSession: 2,
    });
    const created = await store.createSession({ principal: PRINCIPAL });

    const results = await Promise.allSettled([
      store.addTopics(created.sessionId, [TOPIC_A, TOPIC_B]),
      store.addTopics(created.sessionId, [TOPIC_B, TOPIC_C]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const topics = await store.listTopics(created.sessionId);
    expect(topics).toHaveLength(2);
    expect(new Set(topics).size).toBe(2);
  });

  it("checks session existence inside atomic topic admission and does not create orphan topics", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      prefix: "atomic-session-test",
      ticketSecret: "test-secret",
      maxTopicsPerSession: 2,
    });
    const created = await store.createSession({ principal: PRINCIPAL });
    const sessionKey = `atomic-session-test:session:${created.sessionId}`;
    const topicsKey = `${sessionKey}:topics`;
    await redis.del(sessionKey);

    await expect(store.addTopics(created.sessionId, [TOPIC_A])).rejects.toMatchObject({
      code: "invalid_ticket",
      statusCode: 401,
    } satisfies Partial<FepSessionStoreError>);
    await expect(redis.scard(topicsKey)).resolves.toBe(0);
  });

  it("does not allow replaceTopics to bypass the cumulative topic cap", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      maxTopicsPerSession: 2,
    });
    const created = await store.createSession({ principal: PRINCIPAL });
    await store.replaceTopics(created.sessionId, [TOPIC_A]);

    await expect(
      store.replaceTopics(created.sessionId, [TOPIC_A, TOPIC_B, TOPIC_C]),
    ).rejects.toMatchObject({
      code: "topic_limit_exceeded",
      statusCode: 409,
    } satisfies Partial<FepSessionStoreError>);
    await expect(store.listTopics(created.sessionId)).resolves.toEqual([TOPIC_A]);
  });

  it("rejects an oversized legacy topic set before materializing it with SMEMBERS", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      prefix: "topic-bound-test",
      ticketSecret: "test-secret",
      maxTopicsPerSession: 2,
    });
    const created = await store.createSession({ principal: PRINCIPAL });
    await redis.sadd(
      `topic-bound-test:session:${created.sessionId}:topics`,
      TOPIC_A,
      TOPIC_B,
      TOPIC_C,
    );
    const smembers = vi.spyOn(redis, "smembers");

    await expect(store.listTopics(created.sessionId)).rejects.toMatchObject({
      code: "topic_limit_exceeded",
      statusCode: 409,
    } satisfies Partial<FepSessionStoreError>);
    expect(smembers).not.toHaveBeenCalled();
  });
});