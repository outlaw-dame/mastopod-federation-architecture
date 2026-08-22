"use strict";

const PUBLIC_AUDIENCE_URIS = new Set([
  "https://www.w3.org/ns/activitystreams#Public",
  "as:Public",
  "Public",
]);

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeUrl(value, { allowLocalHttp = true } = {}) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol === "https:") {
    return parsed.toString();
  }
  if (
    parsed.protocol === "http:" &&
    allowLocalHttp &&
    LOCALHOST_HOSTNAMES.has(parsed.hostname)
  ) {
    return parsed.toString();
  }

  return null;
}

function isPublicAudience(value) {
  return typeof value === "string" && PUBLIC_AUDIENCE_URIS.has(value.trim());
}

function extractRecipientUris(activity, actorUri, actor) {
  const recipients = new Set();
  const followersUris = buildFollowersCollectionUris(actorUri, actor);

  for (const field of ["to", "cc", "bto", "bcc"]) {
    const values = Array.isArray(activity[field]) ? activity[field] : [activity[field]];
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }

      const trimmed = value.trim();
      if (!trimmed || isPublicAudience(trimmed)) {
        continue;
      }

      if (followersUris.has(trimmed)) {
        recipients.add(trimmed);
        continue;
      }

      const normalized = normalizeUrl(trimmed);
      if (normalized) {
        recipients.add(normalized);
      }
    }
  }

  for (const mentionUri of extractMentionUris(activity)) {
    if (!followersUris.has(mentionUri)) {
      recipients.add(mentionUri);
    }
  }

  return [...recipients];
}

function extractMentionUris(activity) {
  const mentions = new Set();
  for (const container of [activity, activity.object]) {
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      continue;
    }

    const tags = Array.isArray(container.tag) ? container.tag : [container.tag];
    for (const tag of tags) {
      if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
        continue;
      }

      if (tag.type !== "Mention") {
        continue;
      }

      const href = normalizeUrl(tag.href);
      if (href && !isPublicAudience(href)) {
        mentions.add(href);
      }
    }
  }

  return [...mentions];
}

function buildFollowersCollectionUris(actorUri, actor) {
  const followersUris = new Set();
  const actorFollowers = normalizeUrl(actor?.followers);
  const derivedFollowers = normalizeUrl(`${String(actorUri || "").replace(/\/$/, "")}/followers`);

  if (actorFollowers) {
    followersUris.add(actorFollowers);
  }
  if (derivedFollowers) {
    followersUris.add(derivedFollowers);
  }

  return followersUris;
}

async function fetchFollowersActorUris({
  actorUri,
  actor,
  fetchImpl = fetch,
  logger,
  timeoutMs = 10_000,
  maxPages = 10,
  maxFollowerActors = 5_000,
}) {
  const followersUris = buildFollowersCollectionUris(actorUri, actor);
  const queue = [...followersUris];
  const seen = new Set();
  const actorUris = new Set();

  while (queue.length > 0 && seen.size < maxPages && actorUris.size < maxFollowerActors) {
    const url = queue.shift();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/activity+json, application/ld+json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      logger?.warn?.("[ActivityPubRecipientResolution] Failed to fetch followers collection", {
        actorUri,
        followersUrl: url,
        error: error.message,
      });
      continue;
    }

    if (!response.ok) {
      logger?.warn?.("[ActivityPubRecipientResolution] Followers collection returned non-success", {
        actorUri,
        followersUrl: url,
        status: response.status,
      });
      continue;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      logger?.warn?.("[ActivityPubRecipientResolution] Failed to parse followers collection JSON", {
        actorUri,
        followersUrl: url,
        error: error.message,
      });
      continue;
    }

    for (const item of extractCollectionItems(payload)) {
      const candidateUri = getActorUriFromCollectionItem(item);
      const normalized = normalizeUrl(candidateUri);
      if (normalized && !isPublicAudience(normalized) && normalized !== actorUri) {
        actorUris.add(normalized);
      }
      if (actorUris.size >= maxFollowerActors) {
        break;
      }
    }

    const nextUrl = getNextCollectionPageUrl(payload);
    if (nextUrl && !seen.has(nextUrl)) {
      queue.push(nextUrl);
    }

    const firstUrl = getFirstCollectionPageUrl(payload);
    if (firstUrl && !seen.has(firstUrl)) {
      queue.push(firstUrl);
    }
  }

  return [...actorUris];
}

async function resolveDeliveryTargets({
  ctx,
  actorUri,
  actor,
  activity,
  fetchImpl = fetch,
  logger,
  timeoutMs = 10_000,
}) {
  const explicitRecipients = extractRecipientUris(activity, actorUri, actor);
  const followersUris = buildFollowersCollectionUris(actorUri, actor);
  const actorRecipients = new Set();

  for (const recipientUri of explicitRecipients) {
    if (followersUris.has(recipientUri)) {
      const followers = await fetchFollowersActorUris({
        actorUri,
        actor,
        fetchImpl,
        logger,
        timeoutMs,
      });
      for (const followerUri of followers) {
        actorRecipients.add(followerUri);
      }
      continue;
    }

    actorRecipients.add(recipientUri);
  }

  const targets = [];
  for (const recipientUri of actorRecipients) {
    try {
      const isLocal = await ctx.call("activitypub.actor.isLocal", { actorUri: recipientUri });
      if (isLocal) {
        continue;
      }

      const actorDoc = await ctx.call("activitypub.actor.get", { actorUri: recipientUri });
      const inboxUrl = normalizeUrl(actorDoc?.inbox);
      if (!inboxUrl) {
        logger?.warn?.("[ActivityPubRecipientResolution] Recipient actor missing valid inbox", {
          actorUri,
          recipientUri,
        });
        continue;
      }

      const sharedInboxUrl = normalizeUrl(actorDoc?.endpoints?.sharedInbox);
      const deliveryUrl = sharedInboxUrl || inboxUrl;
      const targetDomain = new URL(deliveryUrl).hostname.toLowerCase();

      targets.push({
        recipientUri,
        targetDomain,
        inboxUrl,
        ...(sharedInboxUrl ? { sharedInboxUrl } : {}),
      });
    } catch (error) {
      logger?.warn?.("[ActivityPubRecipientResolution] Failed to resolve recipient actor", {
        actorUri,
        recipientUri,
        error: error.message,
      });
    }
  }

  return deduplicateTargets(targets);
}

function groupTargetsByDomain(actorUri, targets) {
  const grouped = new Map();

  for (const target of targets) {
    const domain = String(target.targetDomain || "").toLowerCase();
    if (!domain) {
      continue;
    }

    const deliveryUrl = target.sharedInboxUrl || target.inboxUrl;
    let group = grouped.get(domain);
    if (!group) {
      group = {
        actor: actorUri,
        targetDomain: domain,
        recipients: new Set(),
        sharedInbox: undefined,
      };
      grouped.set(domain, group);
    }

    group.recipients.add(deliveryUrl);
    if (target.sharedInboxUrl && !group.sharedInbox) {
      group.sharedInbox = target.sharedInboxUrl;
    }
  }

  return [...grouped.values()]
    .map((group) => ({
      actor: group.actor,
      targetDomain: group.targetDomain,
      recipients: [...group.recipients].sort(),
      ...(group.sharedInbox && group.recipients.has(group.sharedInbox)
        ? { sharedInbox: group.sharedInbox }
        : {}),
    }))
    .sort((left, right) => left.targetDomain.localeCompare(right.targetDomain));
}

function deduplicateTargets(targets) {
  const seen = new Set();
  const deduped = [];

  for (const target of targets) {
    const key = `${target.targetDomain}|${target.sharedInboxUrl || target.inboxUrl}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped.sort((left, right) => {
    const leftKey = `${left.targetDomain}|${left.sharedInboxUrl || left.inboxUrl}`;
    const rightKey = `${right.targetDomain}|${right.sharedInboxUrl || right.inboxUrl}`;
    return leftKey.localeCompare(rightKey);
  });
}

function extractCollectionItems(payload) {
  const directItems = Array.isArray(payload?.orderedItems)
    ? payload.orderedItems
    : Array.isArray(payload?.items)
      ? payload.items
      : [];

  if (directItems.length > 0) {
    return directItems;
  }

  if (payload?.first && typeof payload.first === "object" && !Array.isArray(payload.first)) {
    return extractCollectionItems(payload.first);
  }

  return [];
}

function getFirstCollectionPageUrl(payload) {
  if (payload?.first && typeof payload.first === "string") {
    return normalizeUrl(payload.first);
  }

  return null;
}

function getNextCollectionPageUrl(payload) {
  if (payload?.next && typeof payload.next === "string") {
    return normalizeUrl(payload.next);
  }

  return null;
}

function getActorUriFromCollectionItem(item) {
  if (typeof item === "string") {
    return item;
  }

  if (item && typeof item === "object" && !Array.isArray(item)) {
    if (typeof item.id === "string") {
      return item.id;
    }
    if (typeof item["@id"] === "string") {
      return item["@id"];
    }
  }

  return null;
}

function getActivityActorUri(activity) {
  if (typeof activity?.actor === "string") {
    return activity.actor;
  }

  if (activity?.actor && typeof activity.actor === "object" && !Array.isArray(activity.actor)) {
    if (typeof activity.actor.id === "string") {
      return activity.actor.id;
    }
    if (typeof activity.actor["@id"] === "string") {
      return activity.actor["@id"];
    }
  }

  return null;
}

module.exports = {
  PUBLIC_AUDIENCE_URIS,
  buildFollowersCollectionUris,
  extractRecipientUris,
  fetchFollowersActorUris,
  getActivityActorUri,
  groupTargetsByDomain,
  normalizeUrl,
  resolveDeliveryTargets,
};
