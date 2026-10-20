import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("overall federation data-plane proof", () => {
  it("keeps the live signed ActivityPub path wired through Redis, Redpanda, and OpenSearch", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/opensearch-os4b-live-federation.yml"),
      "utf8",
    );
    const verifier = readFileSync(
      resolve(process.cwd(), "scripts/os4b-live-federation-verify.ts"),
      "utf8",
    );

    expect(workflow).toContain("Start Redis, Redpanda, and OpenSearch 3.8");
    expect(workflow).toContain("ENABLE_INBOUND_WORKER=true ENABLE_OPENSEARCH_INDEXER=true");
    expect(workflow).toContain("Send genuinely signed remote ActivityPub Create Notes through Fedify inbox");
    expect(workflow).toContain("Prove Fedify to Redis to Stream2/firehose to canonical OpenSearch projection");
    expect(workflow).toContain("REDPANDA_COMPRESSION=zstd REDPANDA_ZSTD_LEVEL=1");
    expect(workflow).toContain("SEARCH_BACKEND=opensearch OPENSEARCH_URL=http://127.0.0.1:19200");

    expect(verifier).toContain("xRange('ap:queue:inbound:v1'");
    expect(verifier).toContain("topic: 'ap.stream2.remote-public.v1'");
    expect(verifier).toContain("topic: 'ap.firehose.v1'");
    expect(verifier).toContain("index: 'public-content-v1'");
    expect(verifier).toContain("searchHits === expected");
    expect(verifier).toContain("stream2Matched === expected");
    expect(verifier).toContain("firehoseMatched === expected");
    expect(verifier).toContain("inboundObserved === expected");
    expect(verifier).toContain("invalidSearchHits === 0");
    expect(verifier).toContain("stream2Invalid === 0");
    expect(verifier).toContain("firehoseInvalid === 0");
  });

  it("keeps the real implementation matrix on the same Redpanda-governed sidecar startup path", () => {
    const matrix = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );

    expect(matrix).toContain("Start local Redpanda event log");
    expect(matrix).toContain("npm run --prefix fedify-sidecar topics:bootstrap");
    expect(matrix).toContain("REDPANDA_BROKERS=127.0.0.1:19092");
    expect(matrix).toContain("REDPANDA_ENFORCE_TOPIC_GOVERNANCE=true");
    expect(matrix).toContain("STREAM1_TOPIC=ap.stream1.local-public.v1 STREAM2_TOPIC=ap.stream2.remote-public.v1");
    expect(matrix).toContain("FIREHOSE_TOPIC=ap.firehose.v1 TOMBSTONE_TOPIC=ap.tombstones.v1");
  });
});
