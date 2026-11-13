/**
 * Production fence for the legacy mock ATProto adapter.
 *
 * This adapter currently signs JSON rather than canonical CBOR commits,
 * fabricates block CIDs/revisions, stores only Redis metadata, and emits
 * an empty CAR. These outputs MUST NOT be offered as real repository state
 * in a live Personal Data Server. In particular, a fake repo head must never
 * satisfy a unified NEW account's PDS readiness gate.
 *
 * This guard is deliberately scoped to the legacy adapters. Replacing them
 * requires a single durable content-addressed blockstore, signed v3 MST
 * commits, real CAR export, and independently verified DID authority.
 */
export class AtprotoRepositoryNotReadyError extends Error {
  public readonly code = "ATPROTO_PDS_REPOSITORY_NOT_READY";
  public readonly statusCode = 503;
  public readonly retryable = false;

  public constructor() {
    super("Signed AT Protocol repository storage is not available in this adapter");
    this.name = "AtprotoRepositoryNotReadyError";
  }
}

/** Never allow environment overrides to activate mock PDS state in production. */
export function assertMockRepositoryAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new AtprotoRepositoryNotReadyError();
  }
}
