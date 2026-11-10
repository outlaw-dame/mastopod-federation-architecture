import { describe, expect, it } from "vitest";
import { recognizeVerifiedGroupAnnounce } from "../GroupAnnounceWireProfile.js";
const group = "https://lemmy.example/c/science";
const author = "https://remote.example/u/alice";
const post = "https://lemmy.example/post/42";
function lemma() {
  return {
    id: "https://lemmy.example/activities/announce/42",
    type: "Announce",
    actor: group,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [group + "/followers"],
    object: {
      id: "https://remote.example/activities/create/42",
      type: "Create",
      actor: author,
      audience: group,
      object: { id: post, type: "Page", attributedTo: author, audience: group,
        context: "https://lemmy.example/post/42/thread", name: "Science" }
    }
  };
}
describe("FEP-1b12 authenticated Group Announce wire recognition", () => {
  it("preserves Lemmy and Mbin nested Create/Page original author and thread", () => {
    const result = recognizeVerifiedGroupAnnounce({
      activity: lemma(), verifiedActorUri: group, verifiedActorType: "Group"
    });
    expect(result).toEqual({
      groupActorUri: group, announceId: lemma().id,
      innerActivityId: "https://remote.example/activities/create/42",
      contentId: post, contentType: "Page", originalAuthorUri: author,
      context: "https://lemmy.example/post/42/thread", audience: group,
    });
  });
  it("accepts a NodeBB-style direct Note with distinct category audience and topic context", () => {
    const category = "https://nodebb.example/category/science";
    const result = recognizeVerifiedGroupAnnounce({
      activity: { type: "Announce",
        id: "https://nodebb.example/announces/1", actor: category,
        object: { type: "Note", id: "https://nodebb.example/posts/1",
          attributedTo: author, audience: category,
          context: "https://nodebb.example/topic/2" }
      },
      verifiedActorUri: category, verifiedActorType: "Group"
    });
    expect(result?.groupActorUri).toBe(category);
    expect(result?.context).toBe("https://nodebb.example/topic/2");
    expect(result?.originalAuthorUri).toBe(author);
    expect(result?.contentType).toBe("Note");
  });
  it("never treats an unverified Group announcement or ordinary repost as authenticated", () => {
    const announce = lemma();
    expect(recognizeVerifiedGroupAnnounce({
      activity: announce, verifiedActorUri: "https://other.example/group", verifiedActorType: "Group"
    })).toBeNull();
    expect(recognizeVerifiedGroupAnnounce({
      activity: { ...announce, actor: author }, verifiedActorUri: group,
      verifiedActorType: "Group"
    })).toBeNull();
    expect(recognizeVerifiedGroupAnnounce({
      activity: { ...announce, object: post }, verifiedActorUri: group, verifiedActorType: "Group"
    })).toBeNull();
  });
  it("rejects forged nested attribution, unsupported moderation, loops and non-HTTPS actors", () => {
    const a = lemma();
    const cases = [
      { ...a, object: { ...a.object, object: {
        ...(a.object as any).object, attributedTo: "https://attacker.example/user" } } },
      { ...a, object: { ...a.object, type: "Delete" } },
      { ...a, object: { ...a.object, type: "Announce" } },
      { ...a, id: "http://insecure.example/announce" },
      { ...a, object: { ...a.object, object: {
        ...(a.object as any).object, context: { id: 3 } } } },
    ];
    for (const activity of cases) expect(recognizeVerifiedGroupAnnounce({
      activity, verifiedActorUri: group, verifiedActorType: "Group"
    })).toBeNull();
  });
  it("does not change sender authority, trigger network, or emit a Group post", () => {
    const envelope = recognizeVerifiedGroupAnnounce({
      activity: lemma(), verifiedActorUri: group, verifiedActorType: "Group"
    });
    expect(envelope).toBeTruthy();
    expect((envelope as unknown as Record<string, unknown>)["postDelivery"]).toBeUndefined();
    expect((envelope as unknown as Record<string, unknown>)["isMember"]).toBeUndefined();
  });
});
