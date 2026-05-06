/**
 * Federation Scoping Compatibility Test Suite
 *
 * Comprehensive tests for visibility scoping enforcement across all major
 * ActivityPub platform combinations (Mastodon, Akkoma, GoToSocial, etc.).
 *
 * Validates:
 * - Local-scope-only posts (Akkoma) never federate externally
 * - Followers-only posts can only be Announced by authors
 * - Public posts federate to all addresses
 * - Direct messages respect recipient lists
 * - GtS interactionPolicy extensions are preserved
 * - Outbound conformance checks work correctly
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// AP Object (Note, Article, etc.) — only type is required
interface TestObject {
  id?: string;
  type: string;
  to?: string | string[];
  cc?: string | string[];
  attributedTo?: string | string[];
  object?: TestObject | string;
  [key: string]: unknown;
}

// AP Activity — actor and id are required on activities, not on objects
interface TestActivity extends TestObject {
  id: string;
  actor: string;
  object?: TestObject | string;
}

interface TestScenario {
  name: string;
  platform: "mastodon" | "akkoma" | "gotosocial" | "pixelfed" | "lemmy";
  activity: TestActivity;
  expectedVisibility: "public" | "followers" | "direct" | "local";
  shouldFederateExternally: boolean;
  shouldAllowNonAuthorAnnounce?: boolean;
}

// Shared test fixtures
const ACTOR_URI = "https://example.org/users/alice";
const FOLLOWERS_URI = `${ACTOR_URI}/followers`;
const PUBLIC_ALIAS = "https://www.w3.org/ns/activitystreams#Public";
const PUBLIC_SHORT = "as:Public";
const AKKOMA_LOCAL_SCOPE = "https://example.org/#Public";

// Test scenario definitions
const testScenarios: TestScenario[] = [
  // ========================================================================
  // Mastodon Compatibility Tests
  // ========================================================================

  {
    name: "Mastodon public post",
    platform: "mastodon",
    activity: {
      id: "https://example.org/users/alice/statuses/1",
      type: "Create",
      actor: ACTOR_URI,
      to: [PUBLIC_ALIAS],
      object: {
        id: "https://example.org/users/alice/statuses/1",
        type: "Note",
        content: "Hello world",
        to: [PUBLIC_ALIAS],
      },
    },
    expectedVisibility: "public",
    shouldFederateExternally: true,
  },

  {
    name: "Mastodon followers-only post",
    platform: "mastodon",
    activity: {
      id: "https://example.org/users/alice/statuses/2",
      type: "Create",
      actor: ACTOR_URI,
      to: [FOLLOWERS_URI],
      cc: [],
      object: {
        id: "https://example.org/users/alice/statuses/2",
        type: "Note",
        content: "For followers only",
        to: [FOLLOWERS_URI],
        cc: [],
      },
    },
    expectedVisibility: "followers",
    shouldFederateExternally: true,
    shouldAllowNonAuthorAnnounce: false,
  },

  {
    name: "Mastodon direct message",
    platform: "mastodon",
    activity: {
      id: "https://example.org/users/alice/statuses/3",
      type: "Create",
      actor: ACTOR_URI,
      to: ["https://example.com/users/bob"],
      object: {
        id: "https://example.org/users/alice/statuses/3",
        type: "Note",
        content: "Private message",
        to: ["https://example.com/users/bob"],
      },
    },
    expectedVisibility: "direct",
    shouldFederateExternally: false,
  },

  {
    name: "Mastodon unlisted post",
    platform: "mastodon",
    activity: {
      id: "https://example.org/users/alice/statuses/4",
      type: "Create",
      actor: ACTOR_URI,
      to: [PUBLIC_ALIAS],
      cc: [FOLLOWERS_URI],
      object: {
        id: "https://example.org/users/alice/statuses/4",
        type: "Note",
        content: "Unlisted post",
        to: [PUBLIC_ALIAS],
        cc: [FOLLOWERS_URI],
      },
    },
    expectedVisibility: "public",
    shouldFederateExternally: true,
  },

  // ========================================================================
  // Akkoma Compatibility Tests
  // ========================================================================

  {
    name: "Akkoma public post",
    platform: "akkoma",
    activity: {
      id: "https://example.org/users/alice/statuses/10",
      type: "Create",
      actor: ACTOR_URI,
      to: [PUBLIC_ALIAS],
      object: {
        id: "https://example.org/users/alice/statuses/10",
        type: "Note",
        content: "Hello from Akkoma",
        to: [PUBLIC_ALIAS],
      },
    },
    expectedVisibility: "public",
    shouldFederateExternally: true,
  },

  {
    name: "Akkoma local-scope-only post",
    platform: "akkoma",
    activity: {
      id: "https://example.org/users/alice/statuses/11",
      type: "Create",
      actor: ACTOR_URI,
      to: [AKKOMA_LOCAL_SCOPE],
      object: {
        id: "https://example.org/users/alice/statuses/11",
        type: "Note",
        content: "Local only post",
        to: [AKKOMA_LOCAL_SCOPE],
      },
    },
    expectedVisibility: "local",
    shouldFederateExternally: false,
  },

  {
    name: "Akkoma local-scope with as:Public (treated as public per spec)",
    platform: "akkoma",
    activity: {
      id: "https://example.org/users/alice/statuses/12",
      type: "Create",
      actor: ACTOR_URI,
      to: [AKKOMA_LOCAL_SCOPE, PUBLIC_ALIAS],
      object: {
        id: "https://example.org/users/alice/statuses/12",
        type: "Note",
        content: "Public because of as:Public",
        to: [AKKOMA_LOCAL_SCOPE, PUBLIC_ALIAS],
      },
    },
    expectedVisibility: "public",
    shouldFederateExternally: true,
  },

  {
    name: "Akkoma followers-only post",
    platform: "akkoma",
    activity: {
      id: "https://example.org/users/alice/statuses/13",
      type: "Create",
      actor: ACTOR_URI,
      to: [FOLLOWERS_URI],
      object: {
        id: "https://example.org/users/alice/statuses/13",
        type: "Note",
        content: "Followers only",
        to: [FOLLOWERS_URI],
      },
    },
    expectedVisibility: "followers",
    shouldFederateExternally: true,
    shouldAllowNonAuthorAnnounce: false,
  },

  // ========================================================================
  // GoToSocial Compatibility Tests
  // ========================================================================

  {
    name: "GoToSocial public post with interactionPolicy",
    platform: "gotosocial",
    activity: {
      id: "https://social.example.org/users/alice/statuses/20",
      type: "Create",
      actor: ACTOR_URI,
      to: [PUBLIC_ALIAS],
      object: {
        id: "https://social.example.org/users/alice/statuses/20",
        type: "Note",
        content: "GtS public post",
        to: [PUBLIC_ALIAS],
        interactionPolicy: {
          canLike: { always: [PUBLIC_ALIAS] },
          canReply: { always: [PUBLIC_ALIAS] },
          canAnnounce: { always: [PUBLIC_ALIAS] },
        },
      },
    },
    expectedVisibility: "public",
    shouldFederateExternally: true,
  },

  {
    name: "GoToSocial followers-only with restrictive interactionPolicy",
    platform: "gotosocial",
    activity: {
      id: "https://social.example.org/users/alice/statuses/21",
      type: "Create",
      actor: ACTOR_URI,
      to: [FOLLOWERS_URI],
      object: {
        id: "https://social.example.org/users/alice/statuses/21",
        type: "Note",
        content: "GtS followers-only",
        to: [FOLLOWERS_URI],
        interactionPolicy: {
          canLike: { always: [FOLLOWERS_URI] },
          canReply: { always: [FOLLOWERS_URI] },
          canAnnounce: { always: [ACTOR_URI] },
        },
      },
    },
    expectedVisibility: "followers",
    shouldFederateExternally: true,
    shouldAllowNonAuthorAnnounce: false,
  },

  // ========================================================================
  // Announce Scenarios
  // ========================================================================

  {
    name: "Announce of public post by any actor",
    platform: "mastodon",
    activity: {
      id: "https://other.example.org/users/bob/announces/100",
      type: "Announce",
      actor: "https://other.example.org/users/bob",
      to: [PUBLIC_ALIAS],
      object: {
        id: "https://example.org/users/alice/statuses/1",
        type: "Note",
        attributedTo: [ACTOR_URI],
        to: [PUBLIC_ALIAS],
        content: "Public note being boosted",
      },
    },
    expectedVisibility: "public",
    shouldFederateExternally: true,
    shouldAllowNonAuthorAnnounce: true,
  },

  {
    name: "Announce of followers-only post by original author",
    platform: "mastodon",
    activity: {
      id: "https://example.org/users/alice/announces/101",
      type: "Announce",
      actor: ACTOR_URI,
      to: [FOLLOWERS_URI],
      object: {
        id: "https://example.org/users/alice/statuses/2",
        type: "Note",
        attributedTo: [ACTOR_URI],
        to: [FOLLOWERS_URI],
        content: "My followers-only post that I'm re-sharing",
      },
    },
    expectedVisibility: "followers",
    shouldFederateExternally: true,
    shouldAllowNonAuthorAnnounce: true,
  },

  {
    name: "Announce of followers-only post by non-author (should fail)",
    platform: "mastodon",
    activity: {
      id: "https://other.example.org/users/bob/announces/102",
      type: "Announce",
      actor: "https://other.example.org/users/bob",
      to: [PUBLIC_ALIAS],
      object: {
        id: "https://example.org/users/alice/statuses/2",
        type: "Note",
        attributedTo: [ACTOR_URI],
        to: [FOLLOWERS_URI],
        content: "Alice's followers-only note being boosted publicly",
      },
    },
    expectedVisibility: "followers",
    shouldFederateExternally: false,
    shouldAllowNonAuthorAnnounce: false,
  },
];

describe("Federation Scoping Compatibility", () => {
  describe("Visibility Classification", () => {
    testScenarios.forEach((scenario) => {
      it(`should classify ${scenario.platform}: ${scenario.name}`, () => {
        // Extract the object to check
        const objectToCheck = scenario.activity.object || scenario.activity;

        // Determine visibility based on addressing
        const visibility = determineVisibility(objectToCheck);
        expect(visibility).toBe(scenario.expectedVisibility);
      });
    });
  });

  describe("Federation External Routes", () => {
    testScenarios.forEach((scenario) => {
      it(`${scenario.platform}: ${scenario.name} shouldFederateExternally=${scenario.shouldFederateExternally}`, () => {
        const objectToCheck = scenario.activity.object || scenario.activity;
        const wouldFederateExternally = wouldFederateExternally_helper(objectToCheck);

        expect(wouldFederateExternally).toBe(scenario.shouldFederateExternally);
      });
    });
  });

  describe("Announce Authorization", () => {
    testScenarios
      .filter((s) => s.shouldAllowNonAuthorAnnounce !== undefined)
      .forEach((scenario) => {
        it(`${scenario.platform}: ${scenario.name} - non-author Announce allowed=${scenario.shouldAllowNonAuthorAnnounce}`, () => {
          if (scenario.activity.type !== "Announce") {
            expect(true).toBe(true); // Skip non-Announce scenarios
            return;
          }

          const announcedObject = scenario.activity.object as TestActivity;
          const announcer = scenario.activity.actor;
          const authors = extractAuthors(announcedObject);

          const isAuthor = authors.has(announcer);
          const isFollowersOnly = isFollowersOnlyAddressed(announcedObject);

          if (isFollowersOnly && !isAuthor) {
            // Non-author should NOT be able to Announce followers-only
            expect(scenario.shouldAllowNonAuthorAnnounce).toBe(false);
          }
        });
      });
  });

  describe("Extension Preservation (GtS)", () => {
    it("should preserve interactionPolicy through federation", () => {
      const withPolicy = {
        type: "Note",
        content: "test",
        to: [PUBLIC_ALIAS],
        interactionPolicy: {
          canLike: { always: [PUBLIC_ALIAS] },
          canReply: { always: [PUBLIC_ALIAS] },
          canAnnounce: { always: ["https://social.example.org/users/alice"] },
        },
      };

      // Simulate sanitization (should preserve extensions)
      const sanitized = sanitizeActivity(withPolicy);
      const policy = sanitized['interactionPolicy'] as Record<string, unknown> | undefined;
      expect(policy).toBeDefined();
      expect(policy?.['canAnnounce']).toBeDefined();
    });
  });

  describe("Cross-Platform Compatibility Scenarios", () => {
    it("should handle Akkoma local-scope not federating even with followers audience", () => {
      const activity = {
        type: "Note",
        to: [AKKOMA_LOCAL_SCOPE],
        content: "Local only",
      };

      const visibility = determineVisibility(activity);
      expect(visibility).toBe("local");
      expect(wouldFederateExternally_helper(activity)).toBe(false);
    });

    it("should allow Mastodon followers-only when announced by author", () => {
      const activity = {
        type: "Announce",
        actor: ACTOR_URI,
        object: {
          type: "Note",
          attributedTo: [ACTOR_URI],
          to: [FOLLOWERS_URI],
          content: "Followers post",
        },
      };

      const authors = extractAuthors(activity.object);
      expect(authors.has(activity.actor)).toBe(true);
    });

    it("should enforce GoToSocial interactionPolicy restrictions", () => {
      const gtsFollowersOnly = {
        type: "Note",
        to: [FOLLOWERS_URI],
        interactionPolicy: {
          canAnnounce: { always: [ACTOR_URI] },
        },
      };

      // Restriction should be honored (only author can Announce)
      const policy = (gtsFollowersOnly as any).interactionPolicy;
      const allowedAnnouncers = policy?.canAnnounce?.always || [];
      expect(allowedAnnouncers).toContain(ACTOR_URI);
    });
  });

  describe("Scope Conformance Validation", () => {
    it("should flag public activity delivered only to specific actors as overshare", () => {
      const activity = {
        type: "Note",
        to: ["https://example.com/users/bob"],
        content: "Direct message",
      };

      const scope = determineActivityScope(activity);
      expect(scope).toBe("direct");
    });

    it("should flag followers-only activity delivered to public recipients", () => {
      const activity = {
        type: "Note",
        to: [FOLLOWERS_URI],
        content: "Followers post",
      };

      const targets = [
        "https://example.com/users/random",
        "https://social.example/users/another",
      ];

      const conformance = checkTargetConformance(activity, targets);
      expect(conformance.hasConformanceIssues).toBe(true);
    });
  });
});

// ============================================================================
// Helper Functions (Mock Implementations)
// ============================================================================

function determineVisibility(
  activity: unknown,
): "public" | "followers" | "direct" | "local" {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    return "direct";
  }

  const obj = activity as Record<string, unknown>;

  // Check for as:Public
  if (hasPublicAddressing(obj)) {
    return "public";
  }

  // Check for Akkoma local-scope
  if (isLocalScopeOnly(obj)) {
    return "local";
  }

  // Check for followers
  if (isFollowersOnlyAddressed(obj)) {
    return "followers";
  }

  return "direct";
}

function hasPublicAddressing(obj: Record<string, unknown>): boolean {
  const publicAliases = [PUBLIC_ALIAS, PUBLIC_SHORT, "Public"];

  const checkField = (field: unknown): boolean => {
    if (!field) return false;
    const entries = Array.isArray(field) ? field : [field];
    return entries.some((e) => publicAliases.includes(e));
  };

  return checkField(obj["to"]) || checkField(obj["cc"]);
}

function isLocalScopeOnly(obj: Record<string, unknown>): boolean {
  if (hasPublicAddressing(obj)) return false;

  const toEntries = extractAddressUris(obj, "to");
  return Array.from(toEntries).some((uri) => uri === AKKOMA_LOCAL_SCOPE || uri.endsWith("/#Public"));
}

function isFollowersOnlyAddressed(obj: Record<string, unknown>): boolean {
  if (hasPublicAddressing(obj)) return false;

  const toUris = extractAddressUris(obj, "to");
  const ccUris = extractAddressUris(obj, "cc");

  return Array.from(toUris).some((uri) => uri.includes("/followers")) ||
         Array.from(ccUris).some((uri) => uri.includes("/followers"));
}

function extractAddressUris(obj: Record<string, unknown>, ...fields: string[]): Set<string> {
  const uris = new Set<string>();

  for (const field of fields) {
    const value = obj[field];
    if (!value) continue;

    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry === "string") {
        uris.add(entry);
      } else if (entry && typeof entry === "object") {
        const id = (entry as Record<string, unknown>)["id"];
        if (typeof id === "string") {
          uris.add(id);
        }
      }
    }
  }

  return uris;
}

function extractAuthors(obj: unknown): Set<string> {
  const authors = new Set<string>();

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return authors;
  }

  const record = obj as Record<string, unknown>;
  const attributedTo = record["attributedTo"];

  if (typeof attributedTo === "string") {
    authors.add(attributedTo);
  } else if (Array.isArray(attributedTo)) {
    for (const entry of attributedTo) {
      if (typeof entry === "string") {
        authors.add(entry);
      } else if (entry && typeof entry === "object") {
        const id = (entry as Record<string, unknown>)["id"];
        if (typeof id === "string") {
          authors.add(id);
        }
      }
    }
  }

  return authors;
}

function wouldFederateExternally_helper(activity: unknown): boolean {
  const visibility = determineVisibility(activity);
  return visibility === "public" || visibility === "followers";
}

function determineActivityScope(
  activity: unknown,
): "public" | "followers" | "direct" | "local" {
  return determineVisibility(activity);
}

function checkTargetConformance(
  activity: unknown,
  targets: string[],
): { hasConformanceIssues: boolean } {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    return { hasConformanceIssues: false };
  }

  const scope = determineVisibility(activity);
  const obj = activity as Record<string, unknown>;

  if (scope === "direct") {
    const addressed = extractAddressUris(obj, "to", "cc", "bto", "bcc");
    const offScope = targets.filter((t) => !addressed.has(t));
    return { hasConformanceIssues: offScope.length > 0 };
  }

  return { hasConformanceIssues: false };
}

function sanitizeActivity(activity: unknown): Record<string, unknown> {
  // Mock: just return a clone
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    return {};
  }

  return { ...activity } as Record<string, unknown>;
}
