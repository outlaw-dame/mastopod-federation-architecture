from pathlib import Path

# 1) Observation-only is structurally targetless; a normal webhook cannot opt in
# through caller-controlled bridge hints because normal webhook handoffs require
# non-empty targets.
worker = Path('fedify-sidecar/src/delivery/outbox-intent-worker.ts')
text = worker.read_text()
old = '''  private isObservationOnlyIntent(intent: OutboxIntent): boolean {
    return Boolean(
      intent.bridgeHints &&
      typeof intent.bridgeHints === "object" &&
      !Array.isArray(intent.bridgeHints) &&
      intent.bridgeHints["observationOnly"] === true,
    );
  }
'''
new = '''  private isObservationOnlyIntent(intent: OutboxIntent): boolean {
    return Boolean(
      intent.targets.length === 0 &&
      intent.bridgeHints &&
      typeof intent.bridgeHints === "object" &&
      !Array.isArray(intent.bridgeHints) &&
      intent.bridgeHints["observationOnly"] === true,
    );
  }
'''
if text.count(old) != 1:
    raise SystemExit('worker observation guard anchor mismatch')
worker.write_text(text.replace(old, new))

# 2) Interop exception must validate the same normalized delivery URL later used
# for delivery, not a merely present raw sharedInboxUrl.
webhook = Path('fedify-sidecar/src/delivery/outbound-webhook.ts')
text = webhook.read_text()
old = '''  const target = rawTarget as Record<string, unknown>;
  const rawUrl = typeof target["sharedInboxUrl"] === "string"
    ? target["sharedInboxUrl"]
    : target["inboxUrl"];
  if (typeof rawUrl !== "string") return null;

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
'''
new = '''  const target = rawTarget as Record<string, unknown>;
  const sharedInboxUrl = normalizeFederationTargetUrl(target["sharedInboxUrl"]);
  const inboxUrl = normalizeFederationTargetUrl(target["inboxUrl"]);
  const deliveryUrl = sharedInboxUrl ?? inboxUrl;
  if (!deliveryUrl) return null;

  const hostname = new URL(deliveryUrl).hostname.toLowerCase();
'''
if text.count(old) != 1:
    raise SystemExit('interop authority anchor mismatch')
webhook.write_text(text.replace(old, new))

# 3) Replace the old fail-closed test with the correct reserved-hint behavior:
# target-bearing intents must remain normal delivery even if the hint is present.
worker_test = Path('fedify-sidecar/src/delivery/tests/OutboxIntentWorker.test.ts')
text = worker_test.read_text()
start = text.index('  it("fails closed when an observation-only intent contains any delivery target", async () => {')
end = text.index('  it("persists a transient retry before acknowledging the source intent", async () => {', start)
replacement = '''  it("does not let a target-bearing intent opt into observation-only via bridge hints", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const sharedInboxCache = {
      enrichTargets: vi.fn().mockResolvedValue([
        {
          inboxUrl: "https://remote.example/users/bob/inbox",
          sharedInboxUrl: "https://remote.example/inbox",
          deliveryUrl: "https://remote.example/inbox",
          targetDomain: "remote.example",
        },
      ]),
    } as any;
    const worker = new TestOutboxIntentWorker(
      queue,
      redpanda,
      makeConfig({ sharedInboxCache }),
    );
    const intent = makeIntent({ bridgeHints: { observationOnly: true } });

    await worker.runIntent("msg-target-bearing-reserved-hint", intent);

    expect(sharedInboxCache.enrichTargets).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledWith(
      intent.intentId,
      expect.arrayContaining([
        expect.objectContaining({
          targetInbox: "https://remote.example/inbox",
          targetDomain: "remote.example",
        }),
      ]),
    );
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });

'''
worker_test.write_text(text[:start] + replacement + text[end:])

# 4) Prove the interop allowlist follows the effective normalized delivery URL.
webhook_test = Path('fedify-sidecar/src/delivery/tests/OutboundWebhook.test.ts')
text = webhook_test.read_text()
anchor = '''  it("keeps the interop allowlist fail-closed in production and unknown environments", () => {
'''
insert = '''  it("applies the interop allowlist to the actual normalized delivery URL", () => {
    process.env["NODE_ENV"] = "development";
    process.env["APDM_INTEROP_PRIVATE_HOSTS"] = "gotosocial";

    expect(() =>
      normalizeAndDedupeOutboundTargets(
        [
          {
            inboxUrl: "https://attacker.example/inbox",
            sharedInboxUrl: "http://gotosocial/inbox",
          },
        ],
        webhookConfig(),
      ),
    ).toThrowError(OutboundWebhookValidationError);
  });

'''
if text.count(anchor) != 1:
    raise SystemExit('interop test anchor mismatch')
webhook_test.write_text(text.replace(anchor, insert + anchor))

# Self-remove one-shot machinery.
Path('scripts/apdm-phase6-review-hardening-patch.py').unlink()
Path('.github/workflows/apdm-phase6-review-hardening-patch.yml').unlink()
