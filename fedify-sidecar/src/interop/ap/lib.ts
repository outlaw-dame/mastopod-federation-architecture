import { randomUUID } from "node:crypto";

export interface WebFingerLink {
  rel?: unknown;
  type?: unknown;
  href?: unknown;
}

export interface WebFingerDocument {
  subject?: unknown;
  links?: unknown;
}

export interface RemoteInboxTarget {
  actorId: string;
  inboxUrl: string;
  sharedInboxUrl?: string;
}

export interface FollowActivity {
  "@context": "https://www.w3.org/ns/activitystreams";
  id: string;
  type: "Follow";
  actor: string;
  object: string;
  to: [string];
}

export function selectActivityPubSelfLink(document: WebFingerDocument): string {
  if (!Array.isArray(document.links)) {
    throw new Error("WebFinger response is missing links");
  }

  for (const link of document.links as WebFingerLink[]) {
    if (link?.rel !== "self" || typeof link.href !== "string") {
      continue;
    }

    const type = typeof link.type === "string" ? link.type : "";
    if (
      type.includes("application/activity+json")
      || type.includes("application/ld+json")
      || type.length === 0
    ) {
      return link.href;
    }
  }

  throw new Error("WebFinger response did not include an ActivityPub self link");
}

export function extractRemoteInboxTarget(actorDocument: unknown): RemoteInboxTarget {
  if (!actorDocument || typeof actorDocument !== "object" || Array.isArray(actorDocument)) {
    throw new Error("Actor document is not an object");
  }

  const actor = actorDocument as Record<string, unknown>;
  if (typeof actor["id"] !== "string" || actor["id"].length === 0) {
    throw new Error("Actor document is missing id");
  }
  if (typeof actor["inbox"] !== "string" || actor["inbox"].length === 0) {
    throw new Error("Actor document is missing inbox");
  }

  const endpoints = actor["endpoints"];
  const sharedInboxUrl =
    endpoints && typeof endpoints === "object" && !Array.isArray(endpoints)
      ? (endpoints as Record<string, unknown>)["sharedInbox"]
      : undefined;

  return {
    actorId: actor["id"],
    inboxUrl: actor["inbox"],
    ...(typeof sharedInboxUrl === "string" && sharedInboxUrl.length > 0
      ? { sharedInboxUrl }
      : {}),
  };
}

export function requiresSignedActivityPubGet(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

export function buildFollowActivity(params: {
  actorUri: string;
  targetActorUri: string;
  id?: string;
}): FollowActivity {
  const id = params.id ?? `${params.actorUri.replace(/\/+$/, "")}/activities/follow-${randomUUID()}`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "Follow",
    actor: params.actorUri,
    object: params.targetActorUri,
    to: [params.targetActorUri],
  };
}

export function matchesAcceptForFollow(
  candidate: unknown,
  params: {
    followActivityId: string;
    localActorUri: string;
    remoteActorUri: string;
  },
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }

  const activity = candidate as Record<string, unknown>;
  if (activity["type"] !== "Accept") {
    return false;
  }

  const actor = extractObjectId(activity["actor"]);
  if (actor !== params.remoteActorUri) {
    return false;
  }

  const object = activity["object"];
  const acceptedId = extractObjectId(object);
  if (acceptedId === params.followActivityId) {
    return true;
  }

  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return false;
  }

  const followObject = object as Record<string, unknown>;
  if (followObject["type"] !== "Follow") {
    return false;
  }

  return (
    extractObjectId(followObject["id"]) === params.followActivityId
    && extractObjectId(followObject["actor"]) === params.localActorUri
    && extractObjectId(followObject["object"]) === params.remoteActorUri
  );
}

export function matchesRejectForFollow(
  candidate: unknown,
  params: {
    followActivityId: string;
    localActorUri: string;
    remoteActorUri: string;
  },
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }

  const activity = candidate as Record<string, unknown>;
  if (activity["type"] !== "Reject") {
    return false;
  }

  const actor = extractObjectId(activity["actor"]);
  if (actor !== params.remoteActorUri) {
    return false;
  }

  const object = activity["object"];
  const rejectedId = extractObjectId(object);
  if (rejectedId === params.followActivityId) {
    return true;
  }

  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return false;
  }

  const followObject = object as Record<string, unknown>;
  if (followObject["type"] !== "Follow") {
    return false;
  }

  return (
    extractObjectId(followObject["id"]) === params.followActivityId
    && extractObjectId(followObject["actor"]) === params.localActorUri
    && extractObjectId(followObject["object"]) === params.remoteActorUri
  );
}

function extractObjectId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (typeof object["id"] === "string" && object["id"].length > 0) {
      return object["id"];
    }
  }

  return null;
}
