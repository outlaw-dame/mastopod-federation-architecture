import { describe, expect, it } from "vitest";
import { buildProviderCapabilities } from "../provider-capabilities.js";
import { evaluateCapabilityGate } from "../gates.js";
import { validateProviderCapabilitiesConfig } from "../startup-validator.js";

describe("provider capabilities conformance", () => {
  it("ap-scale profile disables at capabilities and denies AT route deterministically", () => {
    const doc = buildProviderCapabilities({
      providerId: "pods.example",
      providerDisplayName: "Example Pods",
      providerRegion: "us-east-1",
      profile: "ap-scale",
      plan: "pro",
      enableInboundWorker: true,
      enableOutboundWorker: true,
      enableOpenSearchIndexer: true,
      enableXrpcServer: false,
      enableMediaPipeline: true,
      enableMrf: true,
      atprotoEnabled: false,
      firehoseRetentionDays: 30,
      includeAtDisabledEntries: true,
    });

    const atEnabled = doc.capabilities.some((entry) => entry.id.startsWith("at.") && entry.status === "enabled");
    expect(atEnabled).toBe(false);

    const gate = evaluateCapabilityGate(doc, "at.xrpc.repo");
    expect(gate.allowed).toBe(false);
    expect(gate.reasonCode).toBe("feature_disabled");
  });

  it("dual-protocol profile passes startup validator when dependencies and infra are present", () => {
    const doc = buildProviderCapabilities({
      providerId: "pods.example",
      providerDisplayName: "Example Pods",
      providerRegion: "us-east-1",
      profile: "dual-protocol-standard",
      plan: "enterprise",
      enableInboundWorker: true,
      enableOutboundWorker: true,
      enableOpenSearchIndexer: true,
      enableXrpcServer: true,
      enableMediaPipeline: true,
      enableMrf: true,
      atprotoEnabled: true,
      firehoseRetentionDays: 30,
      includeAtDisabledEntries: true,
    });

    const result = validateProviderCapabilitiesConfig(doc, {
      profile: "dual-protocol-standard",
      hasRedisUrl: true,
      hasRedpandaBrokers: true,
      hasSigningEndpoint: true,
      hasSigningToken: true,
      hasOpenSearchUrl: true,
      hasActivityPodsUrl: true,
      hasActivityPodsToken: true,
      enableMrf: true,
    });

    expect(result.ok).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "fatal")).toHaveLength(0);
  });

  it("startup validator fails invalid dependency combination firehose enabled without streams", () => {
    const doc = buildProviderCapabilities({
      providerId: "pods.example",
      providerDisplayName: "Example Pods",
      providerRegion: "us-east-1",
      profile: "ap-scale",
      plan: "pro",
      enableInboundWorker: true,
      enableOutboundWorker: true,
      enableOpenSearchIndexer: true,
      enableXrpcServer: false,
      enableMediaPipeline: true,
      enableMrf: true,
      atprotoEnabled: false,
      firehoseRetentionDays: 30,
      includeAtDisabledEntries: true,
    });

    doc.capabilities = doc.capabilities.filter((entry) => entry.id !== "ap.streams");

    const result = validateProviderCapabilitiesConfig(doc, {
      profile: "ap-scale",
      hasRedisUrl: true,
      hasRedpandaBrokers: true,
      hasSigningEndpoint: true,
      hasSigningToken: true,
      hasOpenSearchUrl: true,
      hasActivityPodsUrl: true,
      hasActivityPodsToken: true,
      enableMrf: true,
    });

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("cap_dependency_missing");
  });
});
