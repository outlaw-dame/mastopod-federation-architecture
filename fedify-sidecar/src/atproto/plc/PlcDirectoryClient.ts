/**
 * V6.5 PLC Directory Client - did:plc Operations
 *
 * Communicates with the PLC (Personal LDentifier Cryptosystem) directory
 * to create and update did:plc identifiers.
 *
 * The PLC directory is the authoritative registry for did:plc DIDs.
 * All operations are signed with the rotation key.
 */

import { SigningService, SignPlcOperationRequest } from '../../core-domain/contracts/SigningContracts.js';

/**
 * PLC directory configuration
 */
export interface PlcDirectoryConfig {
  /**
   * PLC directory URL
   * Default: https://plc.directory
   */
  directoryUrl: string;

  /**
   * Request timeout (milliseconds)
   */
  timeoutMs: number;

  /**
   * Retry attempts for transient errors
   */
  maxRetries: number;
}

/**
 * PLC operation
 */
export interface PlcOperation {
  /**
   * Operation type
   */
  type: string;

  /**
   * Rotation keys (priority-ordered)
   */
  rotationKeys: string[];

  /**
   * Verification methods
   */
  verificationMethods: Record<string, string>;

  /**
   * Also known as (aliases)
   */
  alsoKnownAs: string[];

  /**
   * Services
   */
  services: Record<string, { type: string; endpoint: string }>;

  /**
   * Previous operation CID
   */
  prev?: string;

  /**
   * Signature
   */
  sig?: string;
}

/**
 * PLC directory entry
 */
export interface PlcDirectoryEntry {
  /**
   * DID
   */
  did: string;

  /**
   * Current operation CID
   */
  opCid: string;

  /**
   * Operation data
   */
  operation: PlcOperation;

  /**
   * Timestamp of last update
   */
  timestamp: string;
}

/**
 * PLC Directory Client
 *
 * Manages communication with the PLC directory.
 */
export class PlcDirectoryClient {
  private config: PlcDirectoryConfig;

  constructor(
    private signingService: SigningService,
    config?: Partial<PlcDirectoryConfig>
  ) {
    this.config = {
      directoryUrl: 'https://plc.directory',
      timeoutMs: 30000,
      maxRetries: 3,
      ...config,
    };
  }

  /**
   * Create a new DID
   *
   * @param operation - The PLC operation
   * @param canonicalAccountId - Account ID for signing
   * @param rotationKeyRef - Rotation key reference
   * @returns Created DID entry
   * @throws Error on failure
   */
  async createDid(
    operation: PlcOperation,
    canonicalAccountId: string,
    rotationKeyRef: string
  ): Promise<PlcDirectoryEntry> {
    // Sign the operation
    const operationBytes = this.serializeOperation(operation);
    const operationBase64 = Buffer.from(operationBytes).toString('base64');

    const signResponse = await this.signingService.signPlcOperation({
      canonicalAccountId,
      did: '', // Not yet known
      operationBytesBase64: operationBase64,
    });

    // Add signature to operation
    const signedOperation = {
      ...operation,
      sig: signResponse.signatureBase64Url,
    };

    // Submit to PLC directory
    return this.submitOperation(signedOperation, canonicalAccountId);
  }

  /**
   * Update an existing DID
   *
   * @param did - The DID to update
   * @param operation - The PLC operation
   * @param canonicalAccountId - Account ID for signing
   * @param rotationKeyRef - Rotation key reference
   * @returns Updated DID entry
   * @throws Error on failure
   */
  async updateDid(
    did: string,
    operation: PlcOperation,
    canonicalAccountId: string,
    rotationKeyRef: string
  ): Promise<PlcDirectoryEntry> {
    // Get current entry to chain operations
    const current = await this.getEntry(did);
    operation.prev = current.opCid;

    // Sign the operation
    const operationBytes = this.serializeOperation(operation);
    const operationBase64 = Buffer.from(operationBytes).toString('base64');

    const signResponse = await this.signingService.signPlcOperation({
      canonicalAccountId,
      did,
      operationBytesBase64: operationBase64,
    });

    // Add signature to operation
    const signedOperation = {
      ...operation,
      sig: signResponse.signatureBase64Url,
    };

    // Submit to PLC directory
    return this.submitOperation(signedOperation, canonicalAccountId, did);
  }

  /**
   * Get DID entry from directory
   *
   * @param did - The DID to look up
   * @returns DID entry
   * @throws Error if not found or network error
   */
  async getEntry(did: string): Promise<PlcDirectoryEntry> {
    const url = `${this.config.directoryUrl}/${did}`;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`DID not found: ${did}`);
          }
          if (response.status >= 500) {
            // Transient error, retry
            if (attempt < this.config.maxRetries - 1) {
              await this.delay(1000 * (attempt + 1));
              continue;
            }
          }
          throw new Error(`PLC directory error: ${response.status}`);
        }

        const data = await response.json() as Record<string, unknown>;
        return {
          did: String(data.did),
          opCid: String(data.opCid),
          operation: data.operation as PlcOperation,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        if (attempt === this.config.maxRetries - 1) {
          throw error;
        }
        await this.delay(1000 * (attempt + 1));
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Resolve handle to DID
   *
   * @param handle - The handle to resolve
   * @returns DID
   * @throws Error if not found or network error
   */
  async resolveHandle(handle: string): Promise<string> {
    const url = `${this.config.directoryUrl}/resolve/${handle}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Failed to resolve handle: ${response.status}`);
      }

      const data = await response.json() as Record<string, unknown>;
      return String(data.did);
    } catch (error) {
      throw new Error(
        `Failed to resolve handle ${handle}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Submit operation to PLC directory
   *
   * @param operation - The signed operation
   * @param canonicalAccountId - Account ID
   * @param did - Optional existing DID
   * @returns Updated entry
   * @throws Error on failure
   */
  private async submitOperation(
    operation: PlcOperation,
    canonicalAccountId: string,
    did?: string
  ): Promise<PlcDirectoryEntry> {
    const url = did ? `${this.config.directoryUrl}/${did}` : this.config.directoryUrl;
    const method = did ? 'PUT' : 'POST';

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(operation),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          if (response.status >= 500) {
            // Transient error, retry
            if (attempt < this.config.maxRetries - 1) {
              await this.delay(1000 * (attempt + 1));
              continue;
            }
          }
          throw new Error(`PLC directory error: ${response.status}`);
        }

        const data = await response.json() as Record<string, unknown>;
        return {
          did: String(data.did),
          opCid: String(data.opCid),
          operation: data.operation as PlcOperation,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        if (attempt === this.config.maxRetries - 1) {
          throw error;
        }
        await this.delay(1000 * (attempt + 1));
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Serialize operation for signing
   *
   * @param operation - The operation
   * @returns Serialized bytes
   */
  private serializeOperation(operation: PlcOperation): Uint8Array {
    // Use CBOR encoding for PLC operations
    const json = JSON.stringify(operation);
    return new TextEncoder().encode(json);
  }

  /**
   * Delay helper
   *
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

