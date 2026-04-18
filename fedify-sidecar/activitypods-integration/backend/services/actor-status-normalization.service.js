"use strict";

const crypto = require("crypto");
const { MoleculerError } = require("moleculer").Errors;

const STATUS_CHAR_LIMIT = 100;
const MAX_CONTENT_CODEPOINTS = 400;
const MAX_LINK_LABEL_LENGTH = 200;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function countGraphemes(value) {
  const normalized = trimString(value);
  if (!normalized) return 0;

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized)).length;
  }

  return Array.from(normalized).length;
}

function normalizeIsoDate(value) {
  const raw = trimString(value);
  if (!raw) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeHttpUrl(value) {
  const raw = trimString(value);
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeAttachment(value) {
  if (value == null) {
    return undefined;
  }

  const attachment = asObject(value);
  if (!attachment) {
    throw new MoleculerError("status attachment must be an object", 400, "INVALID_STATUS_ATTACHMENT");
  }

  const href = normalizeHttpUrl(attachment.href || attachment.url);
  if (!href) {
    throw new MoleculerError("status attachment href must be an absolute http(s) URL", 400, "INVALID_STATUS_ATTACHMENT");
  }

  const name = trimString(attachment.name);
  if (name.length > MAX_LINK_LABEL_LENGTH) {
    throw new MoleculerError("status attachment name is too long", 400, "INVALID_STATUS_ATTACHMENT");
  }

  return {
    type: "Link",
    href,
    ...(name ? { name } : {}),
  };
}

function normalizeDraft(value, now, options = {}) {
  if (value == null) {
    return null;
  }

  const status = asObject(value);
  if (!status) {
    throw new MoleculerError("status must be an object", 400, "INVALID_STATUS");
  }

  const content = trimString(status.content);
  const endTime = status.endTime == null ? undefined : normalizeIsoDate(status.endTime);
  if (status.endTime != null && !endTime) {
    throw new MoleculerError("status endTime must be a valid date-time", 400, "INVALID_STATUS_END_TIME");
  }
  if (!options.allowPastEndTime && endTime && new Date(endTime).getTime() <= now.getTime()) {
    throw new MoleculerError("status endTime must be in the future", 400, "INVALID_STATUS_END_TIME");
  }

  const attachment = normalizeAttachment(status.attachment);
  if (!content && !attachment && !endTime) {
    return null;
  }
  if (!content) {
    throw new MoleculerError("status content is required", 400, "INVALID_STATUS_CONTENT");
  }
  if (content.length > MAX_CONTENT_CODEPOINTS || countGraphemes(content) > STATUS_CHAR_LIMIT) {
    throw new MoleculerError("status content exceeds the 100 character limit", 400, "INVALID_STATUS_CONTENT");
  }

  return {
    content,
    ...(endTime ? { endTime } : {}),
    ...(attachment ? { attachment } : {}),
  };
}

function draftsEqual(left, right) {
  if (left == null || right == null) {
    return left === right;
  }

  return (
    left.content === right.content &&
    (left.endTime || "") === (right.endTime || "") &&
    ((left.attachment && left.attachment.href) || "") === ((right.attachment && right.attachment.href) || "") &&
    ((left.attachment && left.attachment.name) || "") === ((right.attachment && right.attachment.name) || "")
  );
}

function buildStatusId(actorUri) {
  return `${String(actorUri).replace(/#.*$/, "").replace(/\/+$/, "")}/statuses/${crypto.randomUUID()}`;
}

function normalizeCurrentStatus(actorUri, nextStatus, existingStatus, now) {
  const nextDraft = normalizeDraft(nextStatus, now);
  const existingDraft = normalizeDraft(existingStatus, now, { allowPastEndTime: true });
  if (nextDraft == null) {
    return null;
  }

  const existing = asObject(existingStatus);
  if (existing && draftsEqual(nextDraft, existingDraft)) {
    return existingStatus;
  }

  return {
    type: "ActorStatus",
    id: buildStatusId(actorUri),
    attributedTo: actorUri,
    published: now.toISOString(),
    content: nextDraft.content,
    ...(nextDraft.endTime ? { endTime: nextDraft.endTime } : {}),
    ...(nextDraft.attachment ? { attachment: nextDraft.attachment } : {}),
  };
}

module.exports = {
  name: "actor-status-normalization",

  actions: {
    normalizeCurrentStatus: {
      params: {
        actorUri: "string|min:1",
        nextStatus: { type: "any", optional: true },
        existingStatus: { type: "any", optional: true },
      },
      handler(ctx) {
        const actorUri = trimString(ctx.params.actorUri);
        if (!actorUri) {
          throw new MoleculerError("actorUri is required", 400, "INVALID_INPUT");
        }

        return normalizeCurrentStatus(
          actorUri,
          ctx.params.nextStatus,
          ctx.params.existingStatus,
          new Date(),
        );
      },
    },
  },

  methods: {
    normalizeCurrentStatus,
    normalizeDraft,
    countGraphemes,
  },
};
