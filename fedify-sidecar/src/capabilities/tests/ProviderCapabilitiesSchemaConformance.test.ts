import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProviderCapabilities, renderCapabilitiesResponse } from "../provider-capabilities.js";

describe("provider capabilities schema conformance", () => {
  it("rendered endpoint payload conforms to provider-capabilities.schema.v1.json", async () => {
    const schemaPath = resolve(
      process.cwd(),
      "docs/provider-capabilities/provider-capabilities.schema.v1.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

    const document = buildProviderCapabilities({
      providerId: "pods.example",
      providerDisplayName: "Example Pods",
      providerRegion: "us-east-1",
      profile: "ap-scale",
      plan: "pro",
      enableInboundWorker: true,
      enableOutboundWorker: true,
      enableOpenSearchIndexer: true,
      enableXrpcServer: false,
      enableMrf: true,
      atprotoEnabled: false,
      firehoseRetentionDays: 30,
      includeAtDisabledEntries: true,
    });

    const rendered = renderCapabilitiesResponse(document);
    const payload = JSON.parse(rendered.body);

    const Ajv2020: any = (await import("ajv/dist/2020.js")).default;
    const addFormats: any = (await import("ajv-formats")).default;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(payload);

    expect(ok, JSON.stringify(validate.errors ?? [], null, 2)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });
});
