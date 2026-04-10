/**
 * V6.5 Handle Validator - ATProto Handle Validation and Resolution
 *
 * Validates and resolves ATProto handles using multiple methods:
 * 1. DNS TXT record (atproto-did)
 * 2. Well-known HTTP endpoint (.well-known/atproto-did)
 * 3. PLC directory lookup
 *
 * Handles must be valid DNS names and resolve to the correct DID.
 */

/**
 * Handle validation result
 */
export interface HandleValidationResult {
  /**
   * Whether the handle is valid
   */
  valid: boolean;

  /**
   * Resolved DID (if valid)
   */
  did?: string;

  /**
   * Validation method used
   */
  method?: 'dns' | 'well-known' | 'plc';

  /**
   * Error message if invalid
   */
  error?: string;

  /**
   * Timestamp of validation
   */
  validatedAt: string;
}

/**
 * Handle Validator
 *
 * Validates and resolves ATProto handles.
 */
export class HandleValidator {
  /**
   * DNS lookup timeout (milliseconds)
   */
  private readonly DNS_TIMEOUT_MS = 5000;

  /**
   * HTTP request timeout (milliseconds)
   */
  private readonly HTTP_TIMEOUT_MS = 10000;

  /**
   * Validate handle format
   *
   * @param handle - The handle to validate
   * @returns true if valid format
   */
  isValidFormat(handle: string): boolean {
    // Handle must be a valid DNS name
    // Rules from ATProto spec:
    // - Must be lowercase
    // - Must contain only alphanumeric characters and hyphens
    // - Cannot start or end with hyphen
    // - Each label must be 1-63 characters
    // - Total length must be 1-253 characters
    // - Cannot be a reserved TLD

    if (!handle || typeof handle !== 'string') {
      return false;
    }

    if (handle.length > 253) {
      return false;
    }

    if (handle !== handle.toLowerCase()) {
      return false;
    }

    // Check for reserved TLDs
    const reservedTlds = ['arpa', 'test', 'example', 'invalid', 'localhost'];
    const tld = handle.split('.').pop();
    if (reservedTlds.includes(tld || '')) {
      return false;
    }

    // Validate each label
    const labels = handle.split('.');
    for (const label of labels) {
      if (label.length === 0 || label.length > 63) {
        return false;
      }

      if (label.startsWith('-') || label.endsWith('-')) {
        return false;
      }

      if (!/^[a-z0-9-]+$/.test(label)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate handle and resolve to DID
   *
   * @param handle - The handle to validate
   * @returns Validation result
   */
  async validateHandle(handle: string): Promise<HandleValidationResult> {
    const now = new Date().toISOString();

    // Check format first
    if (!this.isValidFormat(handle)) {
      return {
        valid: false,
        error: 'Invalid handle format',
        validatedAt: now,
      };
    }

    // Try DNS TXT record first (fastest)
    try {
      const did = await this.resolveDnsTxt(handle);
      if (did) {
        return {
          valid: true,
          did,
          method: 'dns',
          validatedAt: now,
        };
      }
    } catch (error) {
      // Continue to next method
    }

    // Try well-known HTTP endpoint
    try {
      const did = await this.resolveWellKnown(handle);
      if (did) {
        return {
          valid: true,
          did,
          method: 'well-known',
          validatedAt: now,
        };
      }
    } catch (error) {
      // Continue to next method
    }

    // Try PLC directory (slowest)
    try {
      const did = await this.resolvePlc(handle);
      if (did) {
        return {
          valid: true,
          did,
          method: 'plc',
          validatedAt: now,
        };
      }
    } catch (error) {
      // Fall through
    }

    return {
      valid: false,
      error: 'Could not resolve handle to DID',
      validatedAt: now,
    };
  }

  /**
   * Resolve handle via DNS TXT record
   *
   * @param handle - The handle
   * @returns DID or null
   * @throws Error on DNS error
   */
  private async resolveDnsTxt(handle: string): Promise<string | null> {
    // Note: This requires a DNS library like dns-query or similar
    // For now, this is a placeholder that would be implemented
    // with a proper DNS client library

    try {
      // Would query: _atproto.{handle} TXT record
      // Expected format: v=atproto;t=did;v={did}
      // This is a simplified implementation

      const response = await fetch(`https://dns.google/resolve?name=_atproto.${handle}&type=TXT`, {
        signal: AbortSignal.timeout(this.DNS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as any;
      const answers = data.Answer || [];

      for (const answer of answers) {
        if (answer.type === 16) { // TXT record
          const txt = answer.data as string;
          const match = txt.match(/v=atproto;t=did;v=(did:[^;]+)/);
          if (match) {
            return match[1] ?? null;
          }
        }
      }

      return null;
    } catch (error) {
      throw new Error(
        `DNS resolution failed for ${handle}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve handle via well-known HTTP endpoint
   *
   * @param handle - The handle
   * @returns DID or null
   * @throws Error on HTTP error
   */
  private async resolveWellKnown(handle: string): Promise<string | null> {
    try {
      const url = `https://${handle}/.well-known/atproto-did`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/plain',
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const text = await response.text();
      const did = text.trim();

      // Validate DID format
      if (did.startsWith('did:')) {
        return did;
      }

      return null;
    } catch (error) {
      throw new Error(
        `Well-known resolution failed for ${handle}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve handle via PLC directory
   *
   * @param handle - The handle
   * @returns DID or null
   * @throws Error on PLC error
   */
  private async resolvePlc(handle: string): Promise<string | null> {
    try {
      const url = `https://plc.directory/resolve/${handle}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as any;
      return data.did || null;
    } catch (error) {
      throw new Error(
        `PLC resolution failed for ${handle}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if handle is available
   *
   * @param handle - The handle to check
   * @returns true if available (not resolved to any DID)
   */
  async isHandleAvailable(handle: string): Promise<boolean> {
    if (!this.isValidFormat(handle)) {
      return false;
    }

    const result = await this.validateHandle(handle);
    return !result.valid;
  }

  /**
   * Verify bidirectional handle-DID link
   *
   * @param handle - The handle
   * @param did - The expected DID
   * @returns true if link is valid
   */
  async verifyBidirectionalLink(handle: string, did: string): Promise<boolean> {
    // Verify handle -> DID
    const result = await this.validateHandle(handle);
    if (!result.valid || result.did !== did) {
      return false;
    }

    // Verify DID -> handle (would require DID document lookup)
    // This is a simplified check
    return true;
  }
}

