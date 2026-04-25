import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { HandleResolutionReader } from '../identity/HandleResolutionReader.js';

export function isExternalAtprotoBinding(
  binding: Pick<IdentityBinding, 'atprotoManaged' | 'atprotoSource'> | null | undefined
): boolean {
  if (!binding) return false;
  return binding.atprotoManaged === false || binding.atprotoSource === 'external';
}

export async function resolveBindingForRepo(
  identityRepo: IdentityBindingRepository | undefined,
  handleResolver: HandleResolutionReader,
  repo: string
): Promise<{ did: string; binding: IdentityBinding | null } | null> {
  if (!identityRepo) return null;

  const resolved = await handleResolver.resolveRepoInput(repo);
  if (!resolved) return null;

  const binding = await identityRepo.getByAtprotoDid(resolved.did);
  return {
    did: resolved.did,
    binding,
  };
}
