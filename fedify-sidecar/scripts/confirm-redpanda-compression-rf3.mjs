import fs from "node:fs";
import path from "node:path";

const inputs = process.argv.slice(2).filter(argument => !argument.startsWith("--output="));
const outputArgument = process.argv.find(argument => argument.startsWith("--output="));
const output = outputArgument?.slice("--output=".length)
  ?? "../measurements/redpanda-compression-rf3-confirmation/decision.json";

if (inputs.length !== 3) {
  throw new Error(`Expected exactly 3 independent RF3 campaign validations, got ${inputs.length}`);
}

const campaigns = inputs.map(input => JSON.parse(fs.readFileSync(input, "utf8")));
const campaignIds = campaigns.map((campaign, index) => {
  if (campaign.schema !== "apdm.redpanda.rf3-production-validation.v2") {
    throw new Error(`Campaign ${index + 1} has unsupported schema ${campaign.schema}`);
  }
  if (campaign.productionArm !== "zstd-1") {
    throw new Error(`Campaign ${index + 1} has unexpected production arm ${campaign.productionArm}`);
  }
  if (typeof campaign.productionArmEligible !== "boolean") {
    throw new Error(`Campaign ${index + 1} is missing a boolean production eligibility result`);
  }
  if (campaign.productionArmEligible !== campaign.zstd1?.eligible) {
    throw new Error(`Campaign ${index + 1} production eligibility disagrees with its Zstd-1 comparison`);
  }
  if (!Array.isArray(campaign.zstd1?.reasons)) {
    throw new Error(`Campaign ${index + 1} is missing Zstd-1 rejection reasons`);
  }
  const campaignId = campaign.campaign?.id;
  if (!Number.isInteger(campaignId) || campaignId < 1) {
    throw new Error(`Campaign ${index + 1} has an invalid campaign identity`);
  }
  return campaignId;
});

if (new Set(campaignIds).size !== campaigns.length) {
  throw new Error(`RF3 campaign identities are not independent: ${JSON.stringify(campaignIds)}`);
}

const confirmationThreshold = 2;
const breachCampaigns = campaigns.filter(campaign => !campaign.productionArmEligible);
const confirmedRegression = breachCampaigns.length >= confirmationThreshold;
const decision = {
  schema: "apdm.redpanda.rf3-campaign-confirmation.v1",
  generatedAt: new Date().toISOString(),
  productionArm: "zstd-1",
  campaignCount: campaigns.length,
  confirmationThreshold,
  breachCount: breachCampaigns.length,
  confirmedRegression,
  productionArmEligible: !confirmedRegression,
  policy: {
    thresholds: "unchanged-per-campaign",
    confirmation: "reject production only when at least two of three independent campaigns breach an unchanged safety gate",
    evidenceRetention: "every campaign result and rejection reason is retained, including unconfirmed breaches",
    promotion: "a different eligible candidate is never promoted automatically",
  },
  campaigns: campaigns.map(campaign => ({
    id: campaign.campaign.id,
    runId: campaign.campaign.runId,
    runAttempt: campaign.campaign.runAttempt,
    eligible: campaign.productionArmEligible,
    selectedCandidateArm: campaign.selectedCandidateArm,
    reasons: campaign.zstd1.reasons,
    ratiosToGzip: campaign.zstd1.ratiosToGzip,
    absoluteTailDeltaMs: campaign.zstd1.absoluteTailDeltaMs,
  })),
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
console.log(JSON.stringify(decision, null, 2));
