vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    request: vi.fn(),
  };
});

import { Readable } from "node:stream";
import { MemoryKvStore } from "@fedify/fedify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import { createFedifyAdapter } from "../FedifyFederationAdapter.js";

const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const ACTOR = "https://example.com/users/alice";
const FOLLOWERS = `${ACTOR}/followers`;
const REMOTE_ACTOR = "https://remote.example/users/bob";

function makeAdapter() {
  return createFedifyAdapter(new MemoryKvStore(), {
    domain: "example.com",
    activityPodsUrl: "http://activitypods.internal",
    activityPodsToken: "test-token",
    requestTimeoutMs: 5_000,
    userAgent: "Fedify-Phase5-Matrix/1.0",
  });
}

function responseBody(text = "accepted"): Readable {
  return Readable.from([Buffer.from(text)]);
}

function activity(id: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ACTOR}/activities/${id}`,
    type,
    actor: ACTOR,
    ...extra,
  };
}

const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id: `${ACTOR}/notes/${id}`,
  type: "Note",
  attributedTo: ACTOR,
  content: `phase5-${id}`,
  ...extra,
});

const cases: Array<{ name: string; value: Record<string, unknown> }> = [
  { name: "Create/public", value: activity("create-public", "Create", { to: [AS_PUBLIC], object: note("public", { to: [AS_PUBLIC] }) }) },
  { name: "Create/unlisted", value: activity("create-unlisted", "Create", { to: [FOLLOWERS], cc: [AS_PUBLIC], object: note("unlisted", { to: [FOLLOWERS], cc: [AS_PUBLIC] }) }) },
  { name: "Create/followers-only", value: activity("create-followers", "Create", { to: [FOLLOWERS], object: note("followers", { to: [FOLLOWERS] }) }) },
  { name: "Create/direct", value: activity("create-direct", "Create", { to: [REMOTE_ACTOR], object: note("direct", { to: [REMOTE_ACTOR] }) }) },
  { name: "Create/reply", value: activity("create-reply", "Create", { to: [REMOTE_ACTOR], cc: [AS_PUBLIC], object: note("reply", { inReplyTo: "https://remote.example/notes/parent", to: [REMOTE_ACTOR], cc: [AS_PUBLIC] }) }) },
  { name: "Follow", value: activity("follow", "Follow", { object: REMOTE_ACTOR, to: [REMOTE_ACTOR] }) },
  { name: "Accept", value: activity("accept", "Accept", { object: { id: `${REMOTE_ACTOR}/activities/follow-alice`, type: "Follow", actor: REMOTE_ACTOR, object: ACTOR }, to: [REMOTE_ACTOR] }) },
  { name: "Undo/Follow", value: activity("undo-follow", "Undo", { object: activity("follow-original", "Follow", { object: REMOTE_ACTOR, to: [REMOTE_ACTOR] }), to: [REMOTE_ACTOR] }) },
  { name: "Announce", value: activity("announce", "Announce", { object: "https://remote.example/notes/announced", to: [AS_PUBLIC], cc: [FOLLOWERS] }) },
  { name: "Like", value: activity("like", "Like", { object: "https://remote.example/notes/liked", to: [REMOTE_ACTOR] }) },
  { name: "Update", value: activity("update", "Update", { to: [AS_PUBLIC], object: note("updated", { to: [AS_PUBLIC], updated: "2026-08-13T09:00:00Z" }) }) },
  { name: "Delete", value: activity("delete", "Delete", { object: `${ACTOR}/notes/deleted`, to: [AS_PUBLIC] }) },
];

describe("APDM Phase 5 outbound protocol matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(request).mockResolvedValue({ statusCode: 202, headers: {}, body: responseBody() } as never);
  });

  it.each(cases)("passes $name unchanged through signing, deadline, and secure HTTP execution", async ({ value }) => {
    const adapter = makeAdapter();
    const body = JSON.stringify(value);
    const valueId = String(value["id"]);
    const signHttpRequest = vi.fn().mockResolvedValue({
      ok: true,
      signedHeaders: {
        date: "Thu, 13 Aug 2026 09:00:00 GMT",
        signature: "keyId=\"test\",signature=\"abc\"",
        digest: "SHA-256=xyz",
      },
    });
    const assertExternalPostAllowed = vi.fn();

    const result = await adapter.deliverOutbound({
      jobId: `matrix-${valueId.split("/").pop()}`,
      actorUri: ACTOR,
      activityId: valueId,
      activity: body,
      targetInbox: "http://localhost:8080/inbox",
      targetDomain: "localhost",
      attempt: 0,
      maxAttempts: 10,
      requestTimeoutMs: 5_000,
      userAgent: "Fedify-Phase5-Matrix/1.0",
      assertExternalPostAllowed,
      signHttpRequest,
    });

    expect(result).toMatchObject({ success: true, statusCode: 202 });
    expect(signHttpRequest).toHaveBeenCalledTimes(1);
    expect(signHttpRequest).toHaveBeenCalledWith({ actorUri: ACTOR, method: "POST", targetUrl: "http://localhost:8080/inbox", body });
    expect(assertExternalPostAllowed).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);

    const [postedUrl, postedOptions] = vi.mocked(request).mock.calls[0]!;
    expect(postedUrl.toString()).toBe("http://localhost:8080/inbox");
    expect(postedOptions).toMatchObject({ method: "POST", body, maxRedirections: 0 });
  });
});
