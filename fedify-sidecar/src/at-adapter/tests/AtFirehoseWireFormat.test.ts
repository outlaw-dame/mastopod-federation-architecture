import { describe, expect, it } from "vitest";
import { decodeFirst, encode } from "cborg";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import { DefaultAtFirehoseEventEncoder } from "../firehose/AtFirehoseEventEncoder.js";
import { DefaultAtFirehoseDecoder, FirehoseDecodeError } from "../ingress/AtFirehoseDecoder.js";

describe("AT firehose wire format", () => {
  it("encodes subscribeRepos events as concatenated CBOR header and payload maps", () => {
    const encoder = new DefaultAtFirehoseEventEncoder();

    const frame = encoder.encodeCommit({
      $type: "#commit",
      seq: 44,
      time: "2026-04-03T12:00:00.000Z",
      repo: "did:plc:alice",
      rev: "3krev",
      since: null,
      commit: "bafy-commit",
      tooBig: false,
      blocks: new Uint8Array([1, 2, 3]),
      ops: [
        {
          action: "create",
          path: "app.bsky.feed.post/3kpost",
          cid: "bafy-record",
        },
      ],
      blobs: [],
      prevData: null,
    });

    const [header, remaining] = decodeFirst(frame);
    const [body, trailing] = decodeFirst(remaining);

    expect(header).toEqual({ op: 1, t: "#commit" });
    expect(body).toEqual(
      expect.objectContaining({
        seq: 44,
        repo: "did:plc:alice",
        rev: "3krev",
        commit: "bafy-commit",
      }),
    );
    expect((body as Record<string, unknown>)["$type"]).toBeUndefined();
    expect(trailing).toHaveLength(0);
  });

  it("round-trips valid concatenated firehose frames through the strict decoder", () => {
    const decoder = new DefaultAtFirehoseDecoder();
    const frame = concatBytes(
      encode({ op: 1, t: "#commit" }),
      encode({
        seq: 101,
        repo: "did:plc:alice",
        rev: "3krev",
        ops: [],
      }),
    );

    expect(decoder.decodeHeader(frame)).toEqual({
      eventType: "#commit",
      seq: 101,
      did: "did:plc:alice",
    });
    expect(decoder.decodeFull(frame)).toEqual({
      header: { op: 1, t: "#commit" },
      body: {
        seq: 101,
        repo: "did:plc:alice",
        rev: "3krev",
        ops: [],
      },
    });
  });

  it("decodes CID-tagged payload fields from strict firehose frames", async () => {
    const decoder = new DefaultAtFirehoseDecoder();
    const commitCid = await dagCborCid({ type: "commit" });
    const prevDataCid = await dagCborCid({ type: "prevData" });
    const frame = concatBytes(
      encode({ op: 1, t: "#commit" }),
      dagCbor.encode({
        seq: 102,
        repo: "did:plc:alice",
        rev: "3krev",
        commit: commitCid,
        prevData: prevDataCid,
        ops: [],
      }),
    );

    const decoded = decoder.decodeFull(frame) as {
      header: Record<string, unknown>;
      body: Record<string, unknown>;
    };

    expect(decoded.header).toEqual({ op: 1, t: "#commit" });
    expect(decoded.body["commit"]).toBeInstanceOf(CID);
    expect((decoded.body["commit"] as CID).toString()).toBe(commitCid.toString());
    expect(decoded.body["prevData"]).toBeInstanceOf(CID);
    expect((decoded.body["prevData"] as CID).toString()).toBe(prevDataCid.toString());
  });

  it("rejects legacy array framing and trailing bytes as invalid firehose frames", () => {
    const decoder = new DefaultAtFirehoseDecoder();
    const legacyArrayFrame = encode([
      { op: 1, t: "#commit" },
      { seq: 101, repo: "did:plc:alice" },
    ]);
    const trailingBytesFrame = concatBytes(
      concatBytes(
        encode({ op: 1, t: "#commit" }),
        encode({ seq: 101, repo: "did:plc:alice" }),
      ),
      Uint8Array.from([0x00]),
    );

    expect(() => decoder.decodeHeader(legacyArrayFrame)).toThrow(FirehoseDecodeError);
    expect(() => decoder.decodeFull(legacyArrayFrame)).toThrow(FirehoseDecodeError);
    expect(() => decoder.decodeHeader(trailingBytesFrame)).toThrow(
      /trailing bytes after payload/i,
    );
    expect(() => decoder.decodeFull(trailingBytesFrame)).toThrow(
      /trailing bytes after payload/i,
    );
  });
});

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

async function dagCborCid(value: unknown): Promise<CID> {
  return CID.createV1(dagCbor.code, await sha256.digest(dagCbor.encode(value)));
}
