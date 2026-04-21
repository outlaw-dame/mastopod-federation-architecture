import { describe, expect, it } from "vitest";
import { activityPubSubjectPolicyRegistration } from "./activitypub-subject-policy.js";

describe("activityPubSubjectPolicyRegistration", () => {
  it("normalizes and dedupes rules by id", () => {
    const existing = activityPubSubjectPolicyRegistration.getDefaultConfig();
    const result = activityPubSubjectPolicyRegistration.validateAndNormalizeConfig(
      {
        rules: [
          {
            id: "rule-1",
            action: "filter",
            actorUri: " https://remote.example/users/alice#main-key ",
          },
          {
            id: "rule-2",
            action: "reject",
            webId: "https://pod.example/alice/profile/card#me",
            domain: "Remote.EXAMPLE",
          },
          {
            id: "rule-2",
            action: "reject",
            webId: "https://pod.example/alice/profile/card#me",
            domain: "https://remote.example/users/alice",
          },
        ],
      },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.rules).toEqual([
      {
        id: "rule-1",
        action: "filter",
        actorUri: "https://remote.example/users/alice",
      },
      {
        id: "rule-2",
        action: "reject",
        webId: "https://pod.example/alice/profile/card#me",
        domain: "remote.example",
      },
    ]);
  });

  it("rejects invalid actor URIs", () => {
    const existing = activityPubSubjectPolicyRegistration.getDefaultConfig();
    expect(() => activityPubSubjectPolicyRegistration.validateAndNormalizeConfig({
      rules: [{ id: "bad-rule", action: "reject", actorUri: "not a uri" }],
    }, { partial: true, existingConfig: existing })).toThrow(/actorUri/);
  });
});
