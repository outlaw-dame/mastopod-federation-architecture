-- Run once, using a migration administrator, in a dedicated Entryway database.
-- Runtime logins inherit paper_entryway_runtime, never paper_entryway_owner.
BEGIN;
CREATE ROLE paper_entryway_owner NOLOGIN;
CREATE ROLE paper_entryway_runtime NOLOGIN;
CREATE SCHEMA paper_entryway AUTHORIZATION paper_entryway_owner;
SET LOCAL ROLE paper_entryway_owner;
REVOKE ALL ON SCHEMA paper_entryway FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA paper_entryway REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION paper_entryway.allowed_keys(value jsonb, keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object' AND
    NOT EXISTS (SELECT FROM jsonb_object_keys(value) k WHERE NOT k = ANY(keys)), false)
$$;

CREATE FUNCTION paper_entryway.valid_route(r jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE p jsonb := r->'provisioning'; item jsonb; k text;
BEGIN
  IF octet_length(r::text) > 65536 OR NOT paper_entryway.allowed_keys(r, ARRAY[
    'accountId','revision','canonicalAccountId','username','handle','webId','actorId',
    'inbox','outbox','followers','following','publicKeyOwner','podStorageUrl','providerId',
    'providerBaseUrl','oidcIssuer','atprotoDid','atprotoHandle','appBootstrap','status',
    'provisioning','createdAt','updatedAt']) OR
    NOT paper_entryway.allowed_keys(p, ARRAY['phase','attempts','fenceToken',
      'providerCreateMayHaveSideEffects','idempotencyKeyHash','requestFingerprint',
      'checks','lastErrorCode','lastErrorMessage','lastAttemptAt','completedAt','ownerSessionProofUses'])
  THEN RETURN false; END IF;
  IF NOT (r ?& ARRAY['accountId','username','status','createdAt','updatedAt','provisioning']) OR
    NOT (p ?& ARRAY['phase','attempts','idempotencyKeyHash','requestFingerprint','checks']) OR
    (r->>'accountId') !~ '^acct_[a-zA-Z0-9-]{1,80}$' OR
    length(r->>'username') NOT BETWEEN 1 AND 128 OR
    r->>'username' <> lower(btrim(r->>'username')) OR
    p->>'idempotencyKeyHash' !~ '^[a-f0-9]{64}$' OR
    p->>'requestFingerprint' !~ '^[a-f0-9]{64}$' OR
    COALESCE(r->>'revision','0') !~ '^[0-9]{1,15}$' OR
    p->>'attempts' !~ '^[0-9]{1,9}$' OR
    NOT (r->>'status' = ANY(ARRAY['provisioning','active','awaiting_consent',
      'reconciliation_required','failed','suspended','migrating'])) OR
    NOT (p->>'phase' = ANY(ARRAY['PENDING','USERNAME_RESERVED','PROVIDER_SELECTED',
      'PROVIDER_CREATE_STARTED','POD_ACCOUNT_CREATED','WEBID_DISCOVERED','ACTOR_VALIDATED',
      'APP_BOOTSTRAP_READY','AWAITING_APP_CONSENT','RECONCILIATION_REQUIRED','SESSION_READY','ACTIVE','FAILED']))
  THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT IN ('revision','provisioning','appBootstrap') AND
      (jsonb_typeof(r->k) <> 'string' OR length(r->>k) > 2048) THEN RETURN false; END IF;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('attempts','providerCreateMayHaveSideEffects','checks','ownerSessionProofUses') AND
      (jsonb_typeof(p->k) <> 'string' OR length(p->>k) > 2048) THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(p->'attempts') <> 'number' OR
    (r ? 'revision' AND jsonb_typeof(r->'revision') <> 'number') THEN RETURN false; END IF;
  IF NOT isfinite((r->>'createdAt')::timestamptz) OR NOT isfinite((r->>'updatedAt')::timestamptz)
    OR (r->>'updatedAt')::timestamptz < (r->>'createdAt')::timestamptz THEN RETURN false; END IF;
  IF p ? 'providerCreateMayHaveSideEffects' AND jsonb_typeof(p->'providerCreateMayHaveSideEffects') <> 'boolean'
    THEN RETURN false; END IF;
  IF jsonb_typeof(p->'checks') <> 'array' OR jsonb_array_length(p->'checks') > 128 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p->'checks') LOOP
    IF NOT paper_entryway.allowed_keys(item, ARRAY['name','status','checkedAt','message','retryable']) OR
      NOT (item ?& ARRAY['name','status','checkedAt']) OR
      jsonb_typeof(item->'name') <> 'string' OR jsonb_typeof(item->'status') <> 'string' OR
      jsonb_typeof(item->'checkedAt') <> 'string' OR NOT isfinite((item->>'checkedAt')::timestamptz)
      THEN RETURN false; END IF;
  END LOOP;
  IF p ? 'ownerSessionProofUses' THEN
    IF jsonb_typeof(p->'ownerSessionProofUses') <> 'array' OR jsonb_array_length(p->'ownerSessionProofUses') > 64
      THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(p->'ownerSessionProofUses') LOOP
      IF NOT paper_entryway.allowed_keys(item, ARRAY['jtiHash','expiresAt']) OR
        NOT (item ?& ARRAY['jtiHash','expiresAt']) OR jsonb_typeof(item->'jtiHash') <> 'string' OR
        jsonb_typeof(item->'expiresAt') <> 'string' OR item->>'jtiHash' !~ '^[a-f0-9]{64}$' OR
        NOT isfinite((item->>'expiresAt')::timestamptz) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  IF r ? 'appBootstrap' AND NOT paper_entryway.allowed_keys(r->'appBootstrap', ARRAY[
    'status','appClientId','appRegistrationUri','accessGrantUris','bootstrappedAt','lastErrorCode','lastErrorMessage'])
    THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
  OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE TABLE paper_entryway.routes (
  account_id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  idempotency_hash text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  revision bigint NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  route jsonb NOT NULL CHECK (paper_entryway.valid_route(route))
);
CREATE INDEX routes_recovery ON paper_entryway.routes(updated_at, account_id) WHERE status = 'provisioning';

-- A logical restore into another database is read-only until operator reconciliation.
CREATE TABLE paper_entryway.installation (
  singleton boolean PRIMARY KEY CHECK (singleton), database_oid oid NOT NULL
);
INSERT INTO paper_entryway.installation SELECT true, oid FROM pg_database WHERE datname = current_database();
CREATE FUNCTION paper_entryway.assert_writable() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM paper_entryway.installation i JOIN pg_database d ON d.oid = i.database_oid
    WHERE d.datname = current_database()) THEN
    RAISE EXCEPTION 'Restored Entryway database requires reconciliation' USING ERRCODE = '55000';
  END IF;
END $$;

CREATE FUNCTION paper_entryway.reserve(r jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE found_route jsonb;
BEGIN
  PERFORM paper_entryway.assert_writable();
  IF NOT paper_entryway.valid_route(r) OR r->>'status' <> 'provisioning' OR
    COALESCE(r->>'revision','0') <> '0' OR r#>>'{provisioning,phase}' <> 'USERNAME_RESERVED' OR
    COALESCE(r#>>'{provisioning,providerCreateMayHaveSideEffects}','false') <> 'false'
    THEN RAISE EXCEPTION 'Invalid initial Entryway route' USING ERRCODE = '22023'; END IF;
  INSERT INTO paper_entryway.routes VALUES (r->>'accountId', r->>'username',
    r#>>'{provisioning,idempotencyKeyHash}', r#>>'{provisioning,requestFingerprint}',
    0, 'provisioning', (r->>'updatedAt')::timestamptz, r)
    ON CONFLICT DO NOTHING RETURNING route INTO found_route;
  IF FOUND THEN RETURN jsonb_build_object('kind','created','route',found_route); END IF;
  SELECT route INTO found_route FROM paper_entryway.routes
    WHERE idempotency_hash = r#>>'{provisioning,idempotencyKeyHash}';
  IF FOUND THEN
    IF found_route#>>'{provisioning,requestFingerprint}' = r#>>'{provisioning,requestFingerprint}'
      THEN RETURN jsonb_build_object('kind','replayed','route',found_route); END IF;
    RETURN jsonb_build_object('kind','idempotency_conflict');
  END IF;
  SELECT route INTO found_route FROM paper_entryway.routes WHERE username = r->>'username';
  IF FOUND THEN RETURN jsonb_build_object('kind','username_taken','route',found_route); END IF;
  -- A UUID collision is not permission to overwrite another account.
  RETURN jsonb_build_object('kind','idempotency_conflict');
END $$;

CREATE FUNCTION paper_entryway.cas(account text, expected_revision bigint, expected_fence text, n jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c jsonb; k text;
BEGIN
  PERFORM paper_entryway.assert_writable();
  IF NOT paper_entryway.valid_route(n) THEN RETURN false; END IF;
  SELECT route INTO c FROM paper_entryway.routes WHERE account_id = account FOR UPDATE;
  IF NOT FOUND OR COALESCE((c->>'revision')::bigint,0) <> expected_revision OR
    COALESCE(c#>>'{provisioning,fenceToken}','') <> expected_fence OR
    (n->>'revision')::bigint IS DISTINCT FROM expected_revision + 1 OR
    (n->>'updatedAt')::timestamptz < (c->>'updatedAt')::timestamptz OR
    NOT (c->>'status' = ANY(ARRAY['provisioning','failed','awaiting_consent']))
    THEN RETURN false; END IF;
  IF c->>'status' = 'provisioning' THEN
    IF NOT (n->>'status' = ANY(ARRAY['provisioning','failed','awaiting_consent','active','reconciliation_required']))
      THEN RETURN false; END IF;
  ELSIF n->>'status' <> 'provisioning' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['accountId','username','createdAt'] LOOP
    IF n->k IS DISTINCT FROM c->k THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['idempotencyKeyHash','requestFingerprint'] LOOP
    IF n->'provisioning'->k IS DISTINCT FROM c->'provisioning'->k THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['providerId','providerBaseUrl','canonicalAccountId','webId','actorId','atprotoDid'] LOOP
    IF COALESCE(c->>k,'') <> '' AND n->k IS DISTINCT FROM c->k THEN RETURN false; END IF;
  END LOOP;
  IF c#>>'{provisioning,providerCreateMayHaveSideEffects}' = 'true' AND
    n#>>'{provisioning,providerCreateMayHaveSideEffects}' IS DISTINCT FROM 'true' THEN RETURN false; END IF;
  -- A stale or compromised writer cannot drop still-live replay evidence.
  IF EXISTS (SELECT FROM jsonb_array_elements(COALESCE(c#>'{provisioning,ownerSessionProofUses}','[]')) old
    WHERE (old->>'expiresAt')::timestamptz > clock_timestamp() AND NOT
      COALESCE(n#>'{provisioning,ownerSessionProofUses}','[]') @> jsonb_build_array(old)) THEN RETURN false; END IF;
  UPDATE paper_entryway.routes SET route = n, revision = expected_revision + 1,
    status = n->>'status', updated_at = (n->>'updatedAt')::timestamptz WHERE account_id = account;
  RETURN true;
END $$;

CREATE FUNCTION paper_entryway.get_account(account text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT route FROM paper_entryway.routes WHERE account_id = account
$$;
CREATE FUNCTION paper_entryway.get_username(name text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT route FROM paper_entryway.routes WHERE username = lower(btrim(name))
$$;
CREATE FUNCTION paper_entryway.stale(before_time timestamptz, batch_size integer) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT route FROM paper_entryway.routes WHERE status = 'provisioning' AND updated_at < before_time
  ORDER BY updated_at, account_id LIMIT greatest(1,least(COALESCE(batch_size,50),500))
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA paper_entryway FROM PUBLIC, paper_entryway_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA paper_entryway FROM PUBLIC;
GRANT USAGE ON SCHEMA paper_entryway TO paper_entryway_runtime;
GRANT EXECUTE ON FUNCTION paper_entryway.reserve(jsonb),
  paper_entryway.cas(text,bigint,text,jsonb), paper_entryway.get_account(text),
  paper_entryway.get_username(text), paper_entryway.stale(timestamptz,integer)
  TO paper_entryway_runtime;
COMMIT;
