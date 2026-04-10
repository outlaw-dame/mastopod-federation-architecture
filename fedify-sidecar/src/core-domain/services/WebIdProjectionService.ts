/**
 * V6.5 WebID Projection Service - Solid WebID RDF Management
 *
 * Manages RDF projections of dual-protocol identities in WebID documents.
 * Creates schema:sameAs and foaf:account links for identity linking.
 *
 * Projections:
 * - schema:sameAs -> ActivityPub actor
 * - schema:sameAs -> ATProto DID
 * - foaf:account -> ActivityPub actor
 * - foaf:account -> ATProto account
 * - rel=\"me\" links in HTML for verification
 */

import { IdentityBinding } from '../identity/IdentityBinding.js';

/**
 * RDF triple for identity linking
 */
export interface RdfTriple {
  /**
   * Subject URI
   */
  subject: string;

  /**
   * Predicate URI
   */
  predicate: string;

  /**
   * Object URI or literal
   */
  object: string;

  /**
   * Whether object is a literal (vs URI)
   */
  isLiteral?: boolean;

  /**
   * Language tag for literals
   */
  language?: string;

  /**
   * Data type for literals
   */
  datatype?: string;
}

/**
 * WebID Projection Service
 *
 * Manages RDF projections for dual-protocol identities in WebID documents.
 */
export class WebIdProjectionService {
  /**
   * Generate RDF triples for identity linking
   *
   * @param binding - The identity binding
   * @returns Array of RDF triples
   */
  generateIdentityTriples(binding: IdentityBinding): RdfTriple[] {
    const triples: RdfTriple[] = [];
    const webId = binding.webId;

    // schema:sameAs -> ActivityPub actor
    triples.push({
      subject: webId,
      predicate: 'http://schema.org/sameAs',
      object: binding.activityPubActorUri,
    });

    // schema:sameAs -> ATProto DID
    if (binding.atprotoDid) {
      triples.push({
        subject: webId,
        predicate: 'http://schema.org/sameAs',
        object: `at://${binding.atprotoDid}`,
      });
    }

    // foaf:account -> ActivityPub actor
    triples.push({
      subject: webId,
      predicate: 'http://xmlns.com/foaf/0.1/account',
      object: binding.activityPubActorUri,
    });

    // foaf:account -> ATProto account
    if (binding.atprotoHandle) {
      triples.push({
        subject: webId,
        predicate: 'http://xmlns.com/foaf/0.1/account',
        object: `at://${binding.atprotoHandle}`,
      });
    }

    // owl:sameAs (stronger identity assertion)
    if (binding.atprotoDid) {
      triples.push({
        subject: binding.activityPubActorUri,
        predicate: 'http://www.w3.org/2002/07/owl#sameAs',
        object: `at://${binding.atprotoDid}`,
      });
    }

    return triples;
  }

  /**
   * Generate Turtle RDF for identity linking
   *
   * @param binding - The identity binding
   * @returns Turtle RDF string
   */
  generateIdentityTurtle(binding: IdentityBinding): string {
    const triples = this.generateIdentityTriples(binding);
    const lines: string[] = [
      '@prefix schema: <http://schema.org/> .',
      '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@prefix at: <at://> .',
      '',
    ];

    for (const triple of triples) {
      lines.push(this.tripleToTurtle(triple));
    }

    return lines.join('\n');
  }

  /**
   * Generate JSON-LD for identity linking
   *
   * @param binding - The identity binding
   * @returns JSON-LD object
   */
  generateIdentityJsonLd(binding: IdentityBinding): Record<string, any> {
    const jsonLd: Record<string, any> = {
      '@context': {
        '@vocab': 'http://schema.org/',
        foaf: 'http://xmlns.com/foaf/0.1/',
        owl: 'http://www.w3.org/2002/07/owl#',
        at: 'at://',
      },
      '@id': binding.webId,
      '@type': 'Person',
      sameAs: [binding.activityPubActorUri],
      'foaf:account': [binding.activityPubActorUri],
    };

    if (binding.atprotoDid) {
      jsonLd.sameAs.push(`at://${binding.atprotoDid}`);
      jsonLd['foaf:account'].push(`at://${binding.atprotoHandle}`);
    }

    return jsonLd;
  }

  /**
   * Generate HTML rel="me" links for verification
   *
   * @param binding - The identity binding
   * @returns Array of HTML link elements
   */
  generateRelMeLinks(binding: IdentityBinding): string[] {
    const links: string[] = [];

    // ActivityPub actor
    links.push(`<link rel="me" href="${this.escapeHtml(binding.activityPubActorUri)}" />`);

    // ATProto DID
    if (binding.atprotoDid) {
      links.push(`<link rel="me" href="at://${this.escapeHtml(binding.atprotoDid)}" />`);
    }

    // ATProto handle
    if (binding.atprotoHandle) {
      links.push(`<link rel="me" href="at://${this.escapeHtml(binding.atprotoHandle)}" />`);
    }

    return links;
  }

  /**
   * Extract identity links from WebID document
   *
   * @param jsonLd - The WebID document as JSON-LD
   * @returns Extracted links
   */
  extractIdentityLinks(jsonLd: Record<string, any>): {
    sameAs: string[];
    accounts: string[];
  } {
    const sameAs: string[] = [];
    const accounts: string[] = [];

    // Extract schema:sameAs
    if (jsonLd.sameAs) {
      if (Array.isArray(jsonLd.sameAs)) {
        sameAs.push(...jsonLd.sameAs);
      } else if (typeof jsonLd.sameAs === 'string') {
        sameAs.push(jsonLd.sameAs);
      }
    }

    // Extract foaf:account
    const foafAccount = jsonLd['foaf:account'] || jsonLd['http://xmlns.com/foaf/0.1/account'];
    if (foafAccount) {
      if (Array.isArray(foafAccount)) {
        accounts.push(...foafAccount);
      } else if (typeof foafAccount === 'string') {
        accounts.push(foafAccount);
      }
    }

    return { sameAs, accounts };
  }

  /**
   * Update WebID document with identity links
   *
   * @param webIdDocument - The WebID document
   * @param binding - The identity binding
   * @returns Updated document
   */
  updateWebIdDocument(
    webIdDocument: Record<string, any>,
    binding: IdentityBinding
  ): Record<string, any> {
    const updated = { ...webIdDocument };

    // Update sameAs
    const sameAs = [binding.activityPubActorUri];
    if (binding.atprotoDid) {
      sameAs.push(`at://${binding.atprotoDid}`);
    }
    updated.sameAs = sameAs;

    // Update foaf:account
    const accounts = [binding.activityPubActorUri];
    if (binding.atprotoHandle) {
      accounts.push(`at://${binding.atprotoHandle}`);
    }
    updated['foaf:account'] = accounts;

    return updated;
  }

  /**
   * Verify bidirectional links
   *
   * @param webIdLinks - Links from WebID
   * @param actorLinks - Links from ActivityPub actor
   * @returns true if links are bidirectional
   */
  verifyBidirectionalLinks(
    webIdLinks: { sameAs: string[]; accounts: string[] },
    actorLinks: string[]
  ): boolean {
    const actorLink = actorLinks[0] ?? '';

    // Check if actor appears in WebID
    const actorInWebId =
      webIdLinks.sameAs.some((link) => link.includes(actorLink)) ||
      webIdLinks.accounts.some((link) => link.includes(actorLink));

    // Check if WebID appears in actor alsoKnownAs
    const webIdInActor = actorLinks.some((link) => link.includes('profile/card#me'));

    return actorInWebId && webIdInActor;
  }

  /**
   * Convert RDF triple to Turtle format
   *
   * @param triple - The RDF triple
   * @returns Turtle representation
   */
  private tripleToTurtle(triple: RdfTriple): string {
    const subject = this.formatTurtleUri(triple.subject);
    const predicate = this.formatTurtleUri(triple.predicate);
    const object = triple.isLiteral
      ? this.formatTurtleLiteral(triple.object, triple.language, triple.datatype)
      : this.formatTurtleUri(triple.object);

    return `${subject} ${predicate} ${object} .`;
  }

  /**
   * Format URI for Turtle
   *
   * @param uri - The URI
   * @returns Formatted URI
   */
  private formatTurtleUri(uri: string): string {
    // Check if it's a prefixed URI
    if (uri.startsWith('http://schema.org/')) {
      return `schema:${uri.substring('http://schema.org/'.length)}`;
    }
    if (uri.startsWith('http://xmlns.com/foaf/0.1/')) {
      return `foaf:${uri.substring('http://xmlns.com/foaf/0.1/'.length)}`;
    }
    if (uri.startsWith('http://www.w3.org/2002/07/owl#')) {
      return `owl:${uri.substring('http://www.w3.org/2002/07/owl#'.length)}`;
    }
    if (uri.startsWith('at://')) {
      return `at:${uri.substring('at://'.length)}`;
    }

    return `<${uri}>`;
  }

  /**
   * Format literal for Turtle
   *
   * @param value - The literal value
   * @param language - Language tag
   * @param datatype - Data type
   * @returns Formatted literal
   */
  private formatTurtleLiteral(value: string, language?: string, datatype?: string): string {
    const escaped = value.replace(/"/g, '\\"');
    let result = `"${escaped}"`;

    if (language) {
      result += `@${language}`;
    } else if (datatype) {
      result += `^^${this.formatTurtleUri(datatype)}`;
    }

    return result;
  }

  /**
   * Escape HTML special characters
   *
   * @param text - The text to escape
   * @returns Escaped text
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char] ?? char);
  }
}
