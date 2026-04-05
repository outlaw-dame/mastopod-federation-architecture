import {
  bootstrapRedpandaTopics,
  resolveTopicGovernanceOptionsFromEnv,
  verifyRedpandaTopics,
} from "../src/streams/redpanda-topic-governance.js";

void main();

async function main(): Promise<void> {
  const options = resolveTopicGovernanceOptionsFromEnv();
  const mode = (process.env["REDPANDA_TOPIC_GOVERNANCE_MODE"] || "bootstrap").trim().toLowerCase();

  if (mode === "verify") {
    await verifyRedpandaTopics(options);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "verify",
          profile: options.profile,
          brokers: options.brokers,
          retries: {
            maxAttempts: options.retryLimit,
            baseDelayMs: options.retryBaseMs,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await bootstrapRedpandaTopics(options);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "bootstrap",
        profile: options.profile,
        brokers: options.brokers,
        requestedTopicCount: result.requestedTopicCount,
        createdTopics: result.createdTopics,
        existingTopics: result.existingTopics,
        reconciledTopics: result.reconciledTopics,
        retries: {
          maxAttempts: options.retryLimit,
          baseDelayMs: options.retryBaseMs,
        },
      },
      null,
      2,
    ),
  );
}
