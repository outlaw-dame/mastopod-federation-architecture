import type { IdentityBinding } from "../../../core-domain/identity/IdentityBinding.js";
import type { CanonicalPost } from "../AtProjectionPolicy.js";

export interface SiteStandardDocumentRecord {
  $type: "site.standard.document";
  title?: string;
  summary?: string;
  text: string;
  publishedAt: string;
  url?: string;
}

export interface StandardDocumentRecordSerializer {
  serialize(post: CanonicalPost, _binding: IdentityBinding): Promise<SiteStandardDocumentRecord>;
}

export class DefaultStandardDocumentRecordSerializer implements StandardDocumentRecordSerializer {
  public async serialize(
    post: CanonicalPost,
    _binding: IdentityBinding,
  ): Promise<SiteStandardDocumentRecord> {
    const text = normalizeDocumentText(post.bodyPlaintext);
    const record: SiteStandardDocumentRecord = {
      $type: "site.standard.document",
      text,
      publishedAt: post.publishedAt || new Date().toISOString(),
    };

    if (typeof post.title === "string" && post.title.trim().length > 0) {
      record.title = post.title.trim();
    }
    if (typeof post.summaryPlaintext === "string" && post.summaryPlaintext.trim().length > 0) {
      record.summary = post.summaryPlaintext.trim();
    }
    if (typeof post.canonicalUrl === "string" && post.canonicalUrl.trim().length > 0) {
      record.url = post.canonicalUrl.trim();
    }

    return record;
  }
}

function normalizeDocumentText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= 100_000) {
    return normalized;
  }
  return normalized.slice(0, 100_000);
}
