import { describe, expect, it, vi } from "vitest";
import type { AtCommitV1 } from "../events/AtRepoEvents.js";
import { DefaultAtFirehosePublisher } from "../firehose/AtFirehosePublisher.js";

describe("DefaultAtFirehosePublisher", () => {
  it("resumes sequence numbers from the cursor store before publishing", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const latestSeq = vi.fn().mockResolvedValue(41);
    const broadcast = vi.fn().mockResolvedValue(undefined);

    const publisher = new DefaultAtFirehosePublisher(
      {
        encodeCommit: vi.fn().mockImplementation((event) => new Uint8Array([event.seq])),
        encodeIdentity: vi.fn().mockImplementation((event) => new Uint8Array([event.seq])),
        encodeAccount: vi.fn().mockImplementation((event) => new Uint8Array([event.seq])),
      },
      {
        append,
        readFrom: vi.fn().mockResolvedValue([]),
        latestSeq,
      },
      {
        attach: vi.fn(),
        detach: vi.fn(),
        broadcast,
      },
      {
        buildFromCommit: vi.fn().mockResolvedValue({
          commitCid: "bafy-commit",
          prevData: null,
          ops: [
            {
              action: "create",
              path: "app.bsky.feed.post/3k1",
              cid: "bafy-record",
            },
          ],
          carSlice: new Uint8Array([1, 2, 3]),
        }),
      },
    );

    await publisher.publishCommit(buildCommitEvent());
    await publisher.publishIdentity({
      version: 1,
      canonicalAccountId: "acct-1",
      did: "did:plc:alice",
      handle: "alice.test",
      canonicalDidMethod: "did:plc",
      pdsEndpoint: "https://pds.example",
      emittedAt: "2026-04-03T12:00:00.000Z",
    });

    expect(latestSeq).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        seq: 42,
        type: "#commit",
      }),
    );
    expect(append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        seq: 43,
        type: "#identity",
      }),
    );
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("surfaces append failures instead of swallowing them", async () => {
    const publisher = new DefaultAtFirehosePublisher(
      {
        encodeCommit: vi.fn().mockReturnValue(new Uint8Array([1])),
        encodeIdentity: vi.fn().mockReturnValue(new Uint8Array([2])),
        encodeAccount: vi.fn().mockReturnValue(new Uint8Array([3])),
      },
      {
        append: vi.fn().mockRejectedValue(new Error("append failed")),
        readFrom: vi.fn().mockResolvedValue([]),
        latestSeq: vi.fn().mockResolvedValue(0),
      },
      {
        attach: vi.fn(),
        detach: vi.fn(),
        broadcast: vi.fn().mockResolvedValue(undefined),
      },
      {
        buildFromCommit: vi.fn().mockResolvedValue({
          commitCid: "bafy-commit",
          prevData: null,
          ops: [],
          carSlice: new Uint8Array([]),
        }),
      },
    );

    await expect(publisher.publishCommit(buildCommitEvent())).rejects.toThrow("append failed");
  });
});

function buildCommitEvent(): AtCommitV1 {
  return {
    did: "did:plc:alice",
    canonicalAccountId: "acct-1",
    rev: "3krev",
    commitCid: "bafy-commit",
    prevCommitCid: null,
    repoVersion: 3,
    ops: [
      {
        action: "create",
        collection: "app.bsky.feed.post",
        rkey: "3k1",
        cid: "bafy-record",
        record: {
          $type: "app.bsky.feed.post",
          text: "Hello world",
        },
      },
    ],
    emittedAt: "2026-04-03T12:00:00.000Z",
  };
}
