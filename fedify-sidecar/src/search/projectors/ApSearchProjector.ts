/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * ApSearchProjector
 * Consumes: ap.firehose.v1, ap.tombstone.v1
 * Outputs: search.public.upsert.v1, search.public.delete.v1
 */

import { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents';
import { IdentityAliasResolver } from '../identity/IdentityAliasResolver';
import { SearchDocIdStrategy } from '../identity/SearchDocIdStrategy';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents';

export class ApSearchProjector {
  constructor(
    private readonly identityResolver: IdentityAliasResolver,
    private readonly eventPublisher: EventPublisher
  ) {}

  /**
   * Process an ActivityPub Create Note event
   */
  async onApFirehoseEvent(event: any): Promise<void> {
    const activity = event.activity;
    if (!activity || activity.type !== 'Create') return;

    const object = activity.object;
    if (!object || typeof object !== 'object' || object.type !== 'Note') return;

    // Only index public content
    const isPublic = this.isPublic(activity) || this.isPublic(object);
    if (!isPublic) return;

    const actorUri = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!actorUri) return;

    const objectUri = typeof object.id === 'string' ? object.id : undefined;
    if (!objectUri) return;

    // Resolve identity
    const identity = await this.identityResolver.resolveByApUri(actorUri);

    // Determine stable ID
    const isLocal = event.origin === 'local';
    const stableDocId = isLocal && identity.canonicalId
      ? SearchDocIdStrategy.forLocal(objectUri) // In a real system, we'd map AP URI to Canonical ID here
      : SearchDocIdStrategy.forRemoteAp(objectUri);

    // Strip HTML from content
    const text = this.stripHtml(object.content || '');

    // Extract media
    const attachments = Array.isArray(object.attachment) ? object.attachment : (object.attachment ? [object.attachment] : []);
    const mediaCount = attachments.length;

    // Extract reply
    const inReplyTo = typeof object.inReplyTo === 'string' ? object.inReplyTo : object.inReplyTo?.id;

    const upsert: SearchPublicUpsertV1 = {
      stableDocId,
      canonicalContentId: isLocal ? objectUri : undefined, // Simplified for Phase 5.25
      protocolSource: 'ap',
      sourceKind: isLocal ? 'local' : 'remote',
      ap: {
        objectUri,
        activityUri: activity.id
      },
      author: {
        canonicalId: identity.canonicalId,
        apUri: actorUri,
        did: identity.atDid,
        handle: identity.atHandle
      },
      content: {
        text,
        createdAt: object.published || activity.published || new Date().toISOString(),
        langs: object.contentMap ? Object.keys(object.contentMap) : undefined,
        tags: this.extractTags(object.tag)
      },
      relations: inReplyTo ? {
        replyToStableId: SearchDocIdStrategy.forRemoteAp(inReplyTo) // Best effort without full resolution
      } : undefined,
      media: {
        hasMedia: mediaCount > 0,
        mediaCount
      },
      indexedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('search.public.upsert.v1', upsert as any);
  }

  /**
   * Process an ActivityPub Delete/Tombstone event
   */
  async onApTombstoneEvent(event: any): Promise<void> {
    const objectUri = event.objectId;
    if (!objectUri) return;

    const isLocal = event.origin === 'local';
    
    // We don't know the canonical ID here easily without a lookup,
    // so we emit with the AP-based stable ID. The IndexWriter will need to handle this.
    const stableDocId = SearchDocIdStrategy.forRemoteAp(objectUri);

    const del: SearchPublicDeleteV1 = {
      stableDocId,
      reason: 'ap_tombstone',
      deletedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('search.public.delete.v1', del as any);
  }

  private isPublic(obj: any): boolean {
    const publicUris = [
      'https://www.w3.org/ns/activitystreams#Public',
      'as:Public',
      'Public'
    ];
    
    const to = Array.isArray(obj.to) ? obj.to : (obj.to ? [obj.to] : []);
    const cc = Array.isArray(obj.cc) ? obj.cc : (obj.cc ? [obj.cc] : []);
    
    return to.some((uri: any) => publicUris.includes(uri)) || cc.some((uri: any) => publicUris.includes(uri));
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>?/gm, '').trim();
  }

  private extractTags(tags: any): string[] | undefined {
    if (!tags) return undefined;
    const tagArray = Array.isArray(tags) ? tags : [tags];
    
    const hashtags = tagArray
      .filter(t => t.type === 'Hashtag' && t.name)
      .map(t => t.name.replace(/^#/, ''));
      
    return hashtags.length > 0 ? hashtags : undefined;
  }
}
