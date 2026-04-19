import { describe, expect, it } from "vitest";
import { Fep3ab2SessionStore, FepSessionStoreError } from "../Fep3ab2SessionStore.js";
import { MemoryRedis } from "./MemoryRedis.js";

describe("Fep3ab2SessionStore", () => {
  it("creates, loads, consumes, and revokes a session ticket", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      ticketTtlSec: 300,
    });

    const created = await store.createSession({
      principal: "https://example.com/users/alice",
      origin: "https://app.example",
      userAgent: "test-agent",
    });

    expect(created.ticket.length).toBeGreaterThan(20);
    expect(created.topics).toEqual([]);

    const loaded = await store.loadControlSession(
      created.ticket,
      "https://example.com/users/alice",
    );
    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.principal).toBe("https://example.com/users/alice");

    const topics = await store.addTopics(created.sessionId, [
      "feeds/public/local",
      "server.example/note/#",
    ]);
    expect(topics).toEqual(["feeds/public/local", "server.example/note/#"]);

    const consumed = await store.consumeStreamTicket(created.ticket, {
      principal: "https://example.com/users/alice",
      origin: "https://app.example",
      userAgent: "test-agent",
    });
    expect(consumed.sessionId).toBe(created.sessionId);
    expect(consumed.topics).toEqual(["feeds/public/local", "server.example/note/#"]);

    await expect(store.consumeStreamTicket(created.ticket)).rejects.toMatchObject({
      code: "ticket_already_used",
      statusCode: 409,
    } satisfies Partial<FepSessionStoreError>);

    await store.revokeByTicket(created.ticket, "https://example.com/users/alice");

    await expect(
      store.loadControlSession(created.ticket, "https://example.com/users/alice"),
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
      principal: "https://example.com/users/alice",
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
      "https://example.com/users/alice",
    );
    expect(stillLoadable.sessionId).toBe(created.sessionId);
  });
});
