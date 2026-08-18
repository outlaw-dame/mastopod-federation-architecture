import { describe, expect, it } from "vitest";
import { parseRedPandaPublishedAt } from "../RemoteFixtureRedPandaProof.js";

describe("ADSP ActivityPods-origin RedPanda proof", () => {
  it("accepts only a canonical positive safe-integer event-log marker", () => {
    expect(parseRedPandaPublishedAt({ eventLogPublishedAt: "1787000000000" })).toBe(1787000000000);
  });

  it("fails closed on missing, malformed, zero, signed, or unsafe markers", () => {
    const cases: Array<Record<string, string>> = [
      {},
      { eventLogPublishedAt: "" },
      { eventLogPublishedAt: "0" },
      { eventLogPublishedAt: "+1" },
      { eventLogPublishedAt: "1junk" },
      { eventLogPublishedAt: "9007199254740992" },
    ];
    for (const raw of cases) {
      expect(() => parseRedPandaPublishedAt(raw)).toThrow(/RedPanda|eventLogPublishedAt/u);
    }
  });
});
