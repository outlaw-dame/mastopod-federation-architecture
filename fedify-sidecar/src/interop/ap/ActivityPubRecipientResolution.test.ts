import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../../../activitypods-integration/activitypub-recipient-resolution.js", import.meta.url),
  "utf8",
);
const commonJsModule: { exports: Record<string, unknown> } = { exports: {} };
new Function("module", "exports", source)(commonJsModule, commonJsModule.exports);
const { resolveDeliveryTargets } = commonJsModule.exports as {
  resolveDeliveryTargets(input: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
};

function makeContext() {
  return {
    call: vi.fn(async (action: string) => {
      if (action === "activitypub.actor.isLocal") return false;
      if (action === "activitypub.actor.get") {
        return {
          inbox: "https://remote.example/users/bob/inbox",
          endpoints: { sharedInbox: "https://remote.example/inbox" },
        };
      }
      throw new Error(`unexpected action ${action}`);
    }),
  };
}

describe("ActivityPub recipient delivery endpoint selection", () => {
  it.each(["Follow", "https://www.w3.org/ns/activitystreams#Follow"])(
    "uses the actor inbox for direct %s delivery",
    async (type) => {
      const targets = await resolveDeliveryTargets({
        ctx: makeContext(),
        actorUri: "https://pods.example/alice",
        actor: {},
        activity: {
          type,
          actor: "https://pods.example/alice",
          object: "https://remote.example/users/bob",
          to: "https://remote.example/users/bob",
        },
      });

      expect(targets).toEqual([
        {
          recipientUri: "https://remote.example/users/bob",
          targetDomain: "remote.example",
          inboxUrl: "https://remote.example/users/bob/inbox",
        },
      ]);
    },
  );

  it("retains shared-inbox aggregation for ordinary fan-out activities", async () => {
    const targets = await resolveDeliveryTargets({
      ctx: makeContext(),
      actorUri: "https://pods.example/alice",
      actor: {},
      activity: {
        type: "Create",
        actor: "https://pods.example/alice",
        to: "https://remote.example/users/bob",
      },
    });

    expect(targets[0]).toMatchObject({
      inboxUrl: "https://remote.example/users/bob/inbox",
      sharedInboxUrl: "https://remote.example/inbox",
    });
  });
});
