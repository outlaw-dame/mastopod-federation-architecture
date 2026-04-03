import { describe, expect, it } from "vitest";
import { DefaultAtBlobStore } from "../../at-adapter/blob/AtBlobStore.js";
import { SyncGetBlobRoute } from "../../at-adapter/xrpc/routes/SyncGetBlobRoute.js";

describe("com.atproto.sync.getBlob route", () => {
  it("serves immutable blob bytes with mime and cache headers", async () => {
    const blobStore = new DefaultAtBlobStore();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
    const meta = await blobStore.putBlob("did:plc:alice", bytes, "image/jpeg");
    const route = new SyncGetBlobRoute({
      blobStore,
      handleResolutionReader: {
        resolveRepoInput: async () => ({ did: "did:plc:alice", handle: "alice.example.com" }),
      } as any,
    });

    const result = await route.handle("did:plc:alice", meta.cid);
    expect(result.body).toEqual(bytes);
    expect(result.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${meta.cid}"`,
      }),
    );
  });
});
