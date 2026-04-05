import type { IdentityBinding } from "../../../core-domain/identity/IdentityBinding.js";
import type { CanonicalPost } from "../AtProjectionPolicy.js";
import type { EmbedBuilder } from "./PostRecordSerializer.js";
import { normalizeAtPostText, type AppBskyFeedPostRecord } from "./PostRecordSerializer.js";

export interface ArticleTeaserRecordSerializer {
  serialize(
    post: CanonicalPost,
    binding: IdentityBinding,
    deps: {
      embedBuilder: EmbedBuilder;
    },
  ): Promise<AppBskyFeedPostRecord>;
}

export class DefaultArticleTeaserRecordSerializer implements ArticleTeaserRecordSerializer {
  public async serialize(
    post: CanonicalPost,
    binding: IdentityBinding,
    deps: {
      embedBuilder: EmbedBuilder;
    },
  ): Promise<AppBskyFeedPostRecord> {
    const record: AppBskyFeedPostRecord = {
      $type: "app.bsky.feed.post",
      text: buildArticleTeaserText(post),
      createdAt: post.publishedAt || new Date().toISOString(),
    };

    const mediaEmbed = await deps.embedBuilder.build(post, binding.atprotoDid!);
    if (mediaEmbed) {
      record.embed = mediaEmbed;
      return record;
    }

    const externalEmbed = buildExternalArticleEmbed(post);
    if (externalEmbed) {
      record.embed = externalEmbed;
    }

    return record;
  }
}

function buildArticleTeaserText(post: CanonicalPost): string {
  const parts = [post.title, post.summaryPlaintext]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const lead = parts.length > 0 ? parts.join(" — ") : post.bodyPlaintext;
  const teaser = normalizeAtPostText(lead);
  const url = normalizeHttpUrl(post.canonicalUrl);
  return url ? normalizeAtPostText(`${teaser}\n\n${url}`) : teaser;
}

function buildExternalArticleEmbed(post: CanonicalPost): Record<string, unknown> | undefined {
  const uri = normalizeHttpUrl(post.canonicalUrl);
  const title = typeof post.title === "string" ? post.title.trim().slice(0, 300) : "";
  if (!uri || !title) {
    return undefined;
  }

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri,
      title,
      description: typeof post.summaryPlaintext === "string"
        ? post.summaryPlaintext.trim().slice(0, 1000)
        : "",
    },
  };
}

function normalizeHttpUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
