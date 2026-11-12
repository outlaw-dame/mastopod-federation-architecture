import { afterEach, describe, expect, it, vi } from "vitest";
import { AtIngressWebhookForwarder } from "../ingress/AtIngressWebhookForwarder.js";
import type { AtIngressEvent } from "../ingress/AtIngressEvents.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const event = (seq: number): AtIngressEvent => ({
  seq, did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  eventType: "#account", verifiedAt: "2026-11-11T10:00:00.000Z",
  source: "wss://relay.example.test", account: { active: true },
});
const endpoint = (name: string) => ({
  id: name, url: `https://${name}.example.test/webhook`, secret: "test-only-shared-secret",
});
const success = () => ({
  status: 202,
  body: { cancel: vi.fn(async () => undefined) },
});

describe("AT ingress endpoint webhook performance and isolation", () => {
  it("starts a second endpoint while an earlier endpoint is blocked", async () => {
    const fwd = new AtIngressWebhookForwarder();
    fwd.registerEndpoint(endpoint("slow"));
    fwd.registerEndpoint(endpoint("fast"));
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("slow")) await slow;
      return success();
    }));
    const pending = fwd.forwardBatch([event(1)]);
    // Flush async workers without releasing the slow endpoint.
    await Promise.resolve();
    expect(calls).toContain(endpoint("fast").url);
    releaseSlow!();
    expect(await pending).toEqual([
      expect.objectContaining({ endpointId: "slow", success: true }),
      expect.objectContaining({ endpointId: "fast", success: true }),
    ]);
  });

  it("bounds concurrent independent endpoints at four", async () => {
    const fwd = new AtIngressWebhookForwarder();
    for (let i = 0; i < 8; i++) fwd.registerEndpoint(endpoint(`out-${i}`));
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
      return success();
    }));
    const result = await fwd.forwardBatch([event(1)]);
    expect(result).toHaveLength(8);
    expect(peak).toBe(4);
  });

  it("serializes an endpoint's chunks and reuses serialized payload across calls", async () => {
    const fwd = new AtIngressWebhookForwarder();
    fwd.registerEndpoint(endpoint("ordered"));
    const sent: number[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push((JSON.parse(String(init.body)) as AtIngressEvent[]).map(e => e.seq));
      expect(init.redirect).toBe("error");
      return success();
    }));
    const results = await fwd.forwardBatch(Array.from({length: 101}, (_, i) => event(i)));
    expect(results).toHaveLength(3);
    expect(sent.map(x => x.length)).toEqual([50, 50, 1]);
    expect(sent.map(x => x[0])).toEqual([0, 50, 100]);
  });

  it("rejects insecure remote endpoints and credential-bearing redirect URLs", () => {
    const fwd = new AtIngressWebhookForwarder();
    for (const url of [
      "http://remote.example.test/hook",
      "https://u:p@remote.example.test/hook",
      "https://remote.example.test/hook#fragment",
    ]) {
      expect(() => fwd.registerEndpoint({id: "invalid", url, secret: "secret"}))
        .toThrow(/canonical HTTPS/);
    }
  });
});
