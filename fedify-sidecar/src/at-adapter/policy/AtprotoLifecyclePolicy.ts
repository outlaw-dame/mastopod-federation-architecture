export type CanonicalAccountLifecycleStatus =
  | 'active'
  | 'disabled'
  | 'pending_deletion'
  | 'deleted';

export type AtprotoBindingLifecycleStatus =
  | 'unlinked'
  | 'pending_verification'
  | 'active'
  | 'refresh_failed'
  | 'relink_required'
  | 'migration_pending'
  | 'disabled';

export type LocalSessionLifecycleStatus =
  | 'none'
  | 'active'
  | 'expired'
  | 'refreshing'
  | 'revoked'
  | 'compromised';

export type RouteModeSupport = 'native' | 'proxy' | 'synthetic' | 'unsupported';

export interface RouteCapability {
  route: string;
  localMode: RouteModeSupport;
  externalMode: RouteModeSupport;
  requiresLocalAuth: boolean;
  requiresBinding: boolean;
  requiresDidMatch: boolean;
  requiresRepoMatch: boolean;
  retryable: boolean;
  cacheable: boolean;
  idempotencyKeyRequired: boolean;
  notes?: string;
}

export interface RouteExecutionBinding {
  atprotoSource?: 'local' | 'external' | null;
  atprotoManaged?: boolean | null;
}

export const ATPROTO_BINDING_TRANSITIONS: Readonly<
  Record<AtprotoBindingLifecycleStatus, readonly AtprotoBindingLifecycleStatus[]>
> = {
  unlinked: ['pending_verification', 'disabled'],
  pending_verification: ['active', 'relink_required', 'disabled'],
  active: ['refresh_failed', 'relink_required', 'migration_pending', 'disabled'],
  refresh_failed: ['active', 'relink_required', 'disabled'],
  relink_required: ['pending_verification', 'disabled'],
  migration_pending: ['active', 'disabled'],
  disabled: [],
};

export const ROUTE_CAPABILITIES: Readonly<Record<string, RouteCapability>> = {
  'com.atproto.server.createSession': {
    route: 'com.atproto.server.createSession',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: false,
    requiresBinding: false,
    requiresDidMatch: false,
    requiresRepoMatch: false,
    retryable: false,
    cacheable: false,
    idempotencyKeyRequired: false,
    notes:
      'External mode authenticates against the upstream PDS, but the sidecar still mints its own local session.',
  },
  'com.atproto.server.refreshSession': {
    route: 'com.atproto.server.refreshSession',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: true,
    requiresBinding: true,
    requiresDidMatch: true,
    requiresRepoMatch: false,
    retryable: true,
    cacheable: false,
    idempotencyKeyRequired: false,
    notes:
      'Refresh uses local single-use refresh-token rotation today. External mode also refreshes upstream session material and re-aliases encrypted session storage.',
  },
  'com.atproto.repo.createRecord': {
    route: 'com.atproto.repo.createRecord',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: true,
    requiresBinding: true,
    requiresDidMatch: true,
    requiresRepoMatch: true,
    retryable: false,
    cacheable: false,
    idempotencyKeyRequired: true,
  },
  'com.atproto.repo.putRecord': {
    route: 'com.atproto.repo.putRecord',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: true,
    requiresBinding: true,
    requiresDidMatch: true,
    requiresRepoMatch: true,
    retryable: false,
    cacheable: false,
    idempotencyKeyRequired: true,
  },
  'com.atproto.repo.deleteRecord': {
    route: 'com.atproto.repo.deleteRecord',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: true,
    requiresBinding: true,
    requiresDidMatch: true,
    requiresRepoMatch: true,
    retryable: false,
    cacheable: false,
    idempotencyKeyRequired: true,
  },
  'com.atproto.repo.getRecord': {
    route: 'com.atproto.repo.getRecord',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: false,
    requiresBinding: false,
    requiresDidMatch: false,
    requiresRepoMatch: false,
    retryable: true,
    cacheable: true,
    idempotencyKeyRequired: false,
  },
  'com.atproto.repo.listRecords': {
    route: 'com.atproto.repo.listRecords',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: false,
    requiresBinding: false,
    requiresDidMatch: false,
    requiresRepoMatch: false,
    retryable: true,
    cacheable: true,
    idempotencyKeyRequired: false,
  },
  'com.atproto.repo.describeRepo': {
    route: 'com.atproto.repo.describeRepo',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: false,
    requiresBinding: false,
    requiresDidMatch: false,
    requiresRepoMatch: false,
    retryable: true,
    cacheable: true,
    idempotencyKeyRequired: false,
  },
  'com.atproto.sync.getLatestCommit': {
    route: 'com.atproto.sync.getLatestCommit',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: false,
    requiresBinding: false,
    requiresDidMatch: false,
    requiresRepoMatch: false,
    retryable: true,
    cacheable: true,
    idempotencyKeyRequired: false,
  },
  'com.atproto.sync.getRepo': {
    route: 'com.atproto.sync.getRepo',
    localMode: 'native',
    externalMode: 'proxy',
    requiresLocalAuth: false,
    requiresBinding: false,
    requiresDidMatch: false,
    requiresRepoMatch: false,
    retryable: true,
    cacheable: false,
    idempotencyKeyRequired: false,
    notes:
      'External mode now proxies CAR export. Local mode still rejects partial export via since until incremental CAR support is built.',
  },
};

export function getRouteCapability(route: string): RouteCapability | null {
  return ROUTE_CAPABILITIES[route] ?? null;
}

export function canTransitionAtprotoBinding(
  current: AtprotoBindingLifecycleStatus,
  next: AtprotoBindingLifecycleStatus
): boolean {
  return ATPROTO_BINDING_TRANSITIONS[current].includes(next);
}

export function resolveRouteExecutionMode(
  binding: RouteExecutionBinding | null | undefined
): 'local' | 'external' {
  if (binding?.atprotoManaged === false || binding?.atprotoSource === 'external') {
    return 'external';
  }
  return 'local';
}

export function assertBindingManagementInvariant(
  binding: RouteExecutionBinding
): asserts binding is RouteExecutionBinding {
  if (binding.atprotoSource === 'local' && binding.atprotoManaged === false) {
    throw new Error('Local ATProto bindings must remain managed by this deployment');
  }

  if (binding.atprotoSource === 'external' && binding.atprotoManaged !== false) {
    throw new Error('External ATProto bindings must remain unmanaged by this deployment');
  }
}
