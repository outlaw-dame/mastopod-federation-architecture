import { describe, expect, it } from "vitest";
import {
  selectExternalAtIngestionSource,
  requireVerifiedExternalFirehoseReady,
  requireVerifiedExternalTopicGovernance,
} from "../ingress/AtExternalIngestionPolicy.js";

describe("external ATProto ingestion policy", () => {
  it("keeps both external sources disabled for providers with no upstream intake", () => {
    expect(selectExternalAtIngestionSource({
      enableVerifiedFirehose: false, enableJetstream: false,
    })).toBe("disabled");
  });

  it("selects the signed Sync v1.1 firehose without creating a Jetstream fallback", () => {
    expect(selectExternalAtIngestionSource({
      enableVerifiedFirehose: true, enableJetstream: false,
    })).toBe("verified");
  });

  it("permits a deliberate low-trust Jetstream-only deployment", () => {
    expect(selectExternalAtIngestionSource({
      enableVerifiedFirehose: false, enableJetstream: true,
    })).toBe("jetstream-unverified");
  });

  it("refuses both external subscribers in any environment before connections open", () => {
    expect(() => selectExternalAtIngestionSource({
      enableVerifiedFirehose: true, enableJetstream: true,
    })).toThrow(/mutually exclusive/);
  });

  it("requires actual raw topic governance for production verified firehose",()=>{
    expect(()=>requireVerifiedExternalTopicGovernance({
      verifiedExternalFirehose:true,environment:"production",governanceEnabled:false,
    })).toThrow(/topic governance/);
    expect(()=>requireVerifiedExternalTopicGovernance({
      verifiedExternalFirehose:true,environment:"production",governanceEnabled:true,
    })).not.toThrow();
    expect(()=>requireVerifiedExternalTopicGovernance({
      verifiedExternalFirehose:false,environment:"production",governanceEnabled:false,
    })).not.toThrow();
    expect(()=>requireVerifiedExternalTopicGovernance({
      verifiedExternalFirehose:true,environment:"test",governanceEnabled:false,
    })).not.toThrow();
  });

  it("never reports the requested verified source as ready without a verifier/runtime", () => {
    expect(() => requireVerifiedExternalFirehoseReady({
      kind: "disabled", reason: "missing_commit_verifier",
    })).toThrow(/missing_commit_verifier/);
    expect(() => requireVerifiedExternalFirehoseReady({
      kind: "disabled", reason: "no_sources",
    })).toThrow(/no_sources/);
    expect(() => requireVerifiedExternalFirehoseReady({kind:"ready"})).not.toThrow();
  });
});
