/**
 * V6.5 Phase 7: com.atproto.repo.describeRepo
 *
 * Returns basic information about a repository: DID, handle, collections
 * present, and account status.  Unauthenticated.
 *
 * This route is read-only and delegates to the existing AtprotoRepoRegistry
 * and HandleResolutionReader from Phase 4.  No new write-path dependencies.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-repo#comatprotorepoDescribeRepo
 */

import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';
import type { AtprotoRepoRegistry } from '../../../atproto/repo/AtprotoRepoRegistry.js';
import type { HandleResolutionReader } from '../../identity/HandleResolutionReader.js';
import { SUPPORTED_COLLECTIONS } from '../../writes/AtWriteTypes.js';
import type { IdentityBindingRepository } from '../../../core-domain/identity/IdentityBindingRepository.js';
import type { ExternalReadGateway } from '../../external/ExternalReadGateway.js';
import { isExternalAtprotoBinding } from '../../external/ExternalAccountMode.js';

export interface RepoDescribeRepoResponse {
  /** DID of the repository */
  handle: string;
  /** DID of the account */
  did: string;
  /** DID document inline */
  didDoc: Record<string, unknown>;
  /** Collections present in this repo */
  collections: string[];
  /** false when account is deactivated/suspended */
  handleIsCorrect: boolean;
}

export class RepoDescribeRepoRoute {
  constructor(
    private readonly repoRegistry: AtprotoRepoRegistry,
    private readonly handleResolver: HandleResolutionReader,
    private readonly identityRepo?: IdentityBindingRepository,
    private readonly externalReadGateway?: ExternalReadGateway,
  ) {}

  async handle(
    repo: string | undefined
  ): Promise<{ headers: Record<string, string>; body: RepoDescribeRepoResponse }> {
    if (!repo?.trim()) {
      throw XrpcErrors.invalidRequest('repo parameter is required');
    }

    // Resolve DID from either a DID string or a handle
    const resolved = await this.handleResolver.resolveRepoInput(repo.trim());
    if (!resolved) {
      throw XrpcErrors.repoNotFound(repo.trim());
    }

    // Look up current repo state
    const repoState = await this.repoRegistry.getRepoState(resolved.did);

    // Optionally enrich with identity binding data when repository wiring provides it.
    const binding = this.identityRepo
      ? await this.identityRepo.getByAtprotoDid(resolved.did)
      : null;

    if (isExternalAtprotoBinding(binding)) {
      if (!binding?.atprotoPdsEndpoint || !this.externalReadGateway) {
        throw XrpcErrors.repoNotFound(resolved.did);
      }

      const external = await this.externalReadGateway.describeRepo(
        binding.atprotoPdsEndpoint,
        resolved.handle ?? resolved.did
      );

      return {
        headers: {
          'Content-Type': 'application/json',
        },
        body: external.body as RepoDescribeRepoResponse,
      };
    }

    const resolvedHandle = resolved.handle ?? binding?.atprotoHandle ?? '';
    const handleIsCorrect = resolvedHandle
      ? (await this.handleResolver.resolveHandle(resolvedHandle)) === resolved.did
      : false;

    // Collections present are those in repository state; normalize object and
    // string forms, then fall back to supported defaults when empty.
    const knownCollections = Array.isArray(repoState?.collections)
      ? repoState.collections
          .map((collection: unknown) => {
            if (typeof collection === 'string') return collection;
            if (
              collection &&
              typeof collection === 'object' &&
              'nsid' in collection &&
              typeof (collection as { nsid: unknown }).nsid === 'string'
            ) {
              return (collection as { nsid: string }).nsid;
            }
            return null;
          })
          .filter((collection): collection is string => Boolean(collection))
      : [];

    const collections = knownCollections.length > 0
      ? [...new Set(knownCollections)]
      : [...SUPPORTED_COLLECTIONS];

    // Build a compatibility DID document with optional PDS endpoint and handle alias.
    const didDoc: Record<string, unknown> = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: resolved.did,
      ...(resolvedHandle ? { alsoKnownAs: [`at://${resolvedHandle}`] } : {}),
      ...(binding?.atprotoPdsEndpoint
        ? {
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: binding.atprotoPdsEndpoint,
              },
            ],
          }
        : {}),
    };

    return {
      headers: { 'Content-Type': 'application/json' },
      body: {
        handle: resolvedHandle,
        did: resolved.did,
        didDoc,
        collections,
        // true only when handle->did round-trips to this repository DID.
        handleIsCorrect,
      },
    };
  }
}
