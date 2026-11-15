import type { Redis } from "ioredis";
import { deepClone, safeJsonParse } from "./stable.js";
import type {
  AccountRoute,
  AccountRouteReservationInput,
  AccountRouteReservationResult,
  AccountRouteStore,
} from "./types.js";

const STALE_ROUTE_MGET_BATCH_SIZE = 256;

export class InMemoryAccountRouteStore implements AccountRouteStore {
  private readonly routesByAccountId = new Map<string, AccountRoute>();
  private readonly accountIdByUsername = new Map<string, string>();
  private readonly idempotency = new Map<string, { fingerprint: string; accountId: string }>();

  public async reserve(input: AccountRouteReservationInput): Promise<AccountRouteReservationResult> {
    const existingIdempotency = this.idempotency.get(input.idempotencyKeyHash);
    if (existingIdempotency) {
      const route = this.routesByAccountId.get(existingIdempotency.accountId);
      if (existingIdempotency.fingerprint !== input.requestFingerprint) {
        return { kind: "idempotency_conflict", route: route ? deepClone(route) : undefined };
      }
      if (route) {
        return { kind: "replayed", route: deepClone(route) };
      }
    }

    const usernameKey = normalizeUsernameKey(input.username);
    const existingAccountId = this.accountIdByUsername.get(usernameKey);
    if (existingAccountId) {
      const route = this.routesByAccountId.get(existingAccountId);
      if (route) {
        return { kind: "username_taken", route: deepClone(route) };
      }
    }

    const route = deepClone(input.route);
    this.routesByAccountId.set(input.accountId, route);
    this.accountIdByUsername.set(usernameKey, input.accountId);
    this.idempotency.set(input.idempotencyKeyHash, {
      fingerprint: input.requestFingerprint,
      accountId: input.accountId,
    });
    return { kind: "created", route: deepClone(route) };
  }

  public async getByAccountId(accountId: string): Promise<AccountRoute | null> {
    const route = this.routesByAccountId.get(accountId);
    return route ? deepClone(route) : null;
  }

  public async getByUsername(username: string): Promise<AccountRoute | null> {
    const accountId = this.accountIdByUsername.get(normalizeUsernameKey(username));
    if (!accountId) {
      return null;
    }
    return this.getByAccountId(accountId);
  }

  // Test fixture seeding only; the production Redis implementation has no
  // unconditional overwrite API. Runtime updates use compareAndSet below.
  public async save(route: AccountRoute): Promise<void> {
    const cloned = deepClone(route);
    this.routesByAccountId.set(cloned.accountId, cloned);
    this.accountIdByUsername.set(normalizeUsernameKey(cloned.username), cloned.accountId);
  }

  public async compareAndSet(expected: AccountRoute, next: AccountRoute): Promise<boolean> {
    const current = this.routesByAccountId.get(expected.accountId);
    if (!current || !isValidRouteTransition(current, expected, next)) {
      return false;
    }
    this.routesByAccountId.set(expected.accountId, deepClone(next));
    return true;
  }

  public async listStaleProvisioning(beforeIso: string, limit: number): Promise<AccountRoute[]> {
    const beforeMs = Date.parse(beforeIso);
    if (!Number.isFinite(beforeMs)) {
      return [];
    }

    return [...this.routesByAccountId.values()]
      .filter((route) => route.status === "provisioning")
      .filter((route) => Date.parse(route.updatedAt) < beforeMs)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, clampLimit(limit))
      .map((route) => deepClone(route));
  }
}

export class RedisAccountRouteStore implements AccountRouteStore {
  public constructor(
    private readonly redis: Redis,
    private readonly prefix = "entryway:accounts",
  ) {}

  public async reserve(input: AccountRouteReservationInput): Promise<AccountRouteReservationResult> {
    const accountId = input.accountId;
    const result = await this.redis.eval(
      RESERVE_ROUTE_LUA,
      4,
      this.idempotencyKey(input.idempotencyKeyHash),
      this.usernameKey(input.username),
      this.routeKey(accountId),
      this.indexKey(),
      input.requestFingerprint,
      accountId,
      JSON.stringify(input.route),
      String(Date.parse(input.route.createdAt) || Date.now()),
    ) as unknown;

    const [kind, existingAccountId] = Array.isArray(result) ? result.map(String) : ["idempotency_conflict", ""];

    if (kind === "created") {
      return { kind: "created", route: input.route };
    }

    const existingRoute = existingAccountId ? await this.getByAccountId(existingAccountId) : null;
    if (kind === "replayed" && existingRoute) {
      return { kind: "replayed", route: existingRoute };
    }
    if (kind === "username_taken" && existingRoute) {
      return { kind: "username_taken", route: existingRoute };
    }
    return { kind: "idempotency_conflict", route: existingRoute ?? undefined };
  }

  public async getByAccountId(accountId: string): Promise<AccountRoute | null> {
    return safeJsonParse<AccountRoute>(await this.redis.get(this.routeKey(accountId)));
  }

  public async getByUsername(username: string): Promise<AccountRoute | null> {
    const accountId = await this.redis.get(this.usernameKey(username));
    if (!accountId) {
      return null;
    }
    return this.getByAccountId(accountId);
  }

  public async compareAndSet(expected: AccountRoute, next: AccountRoute): Promise<boolean> {
    if (!isValidRouteTransition(expected, expected, next)) {
      return false;
    }
    const result = await this.redis.eval(
      COMPARE_ROUTE_LUA,
      2,
      this.routeKey(expected.accountId),
      this.indexKey(),
      String(expected.revision ?? 0),
      expected.provisioning.fenceToken ?? "",
      JSON.stringify(next),
      String(Date.parse(next.updatedAt)),
      expected.accountId,
    );
    return result === 1;
  }

  public async listStaleProvisioning(beforeIso: string, limit: number): Promise<AccountRoute[]> {
    const beforeMs = Date.parse(beforeIso);
    if (!Number.isFinite(beforeMs)) {
      return [];
    }

    const boundedLimit = clampLimit(limit);
    // Older deployments indexed creation time and retained completed rows.
    // Examine a bounded window, repair index drift, and drain old non-pending
    // entries incrementally. No account-wide read or unbounded Redis scan.
    const scanBudget = Math.min(4096, Math.max(1024, boundedLimit * 3));
    const accountIds = await this.redis.zrangebyscore(
      this.indexKey(), "-inf", String(beforeMs), "LIMIT", 0, scanBudget,
    );
    const routes = await this.loadRoutesByAccountIds(accountIds);
    const stale: AccountRoute[] = [];
    const remove: string[] = [];
    const rescore: Array<{ accountId: string; timestamp: number }> = [];
    for (let index = 0; index < accountIds.length; index += 1) {
      const accountId = accountIds[index]!;
      const route = routes[index];
      if (!route || route.accountId !== accountId || route.status !== "provisioning") {
        remove.push(accountId);
        continue;
      }
      const updatedAtMs = Date.parse(route.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        remove.push(accountId);
        continue;
      }
      // Rescore legacy entries by last update, even if they are not stale.
      rescore.push({ accountId, timestamp: updatedAtMs });
      if (updatedAtMs < beforeMs) {
        stale.push(route);
      }
    }
    if (remove.length || rescore.length) {
      const pipeline = this.redis.pipeline();
      for (const accountId of remove) pipeline.zrem(this.indexKey(), accountId);
      for (const entry of rescore) {
        pipeline.zadd(this.indexKey(), String(entry.timestamp), entry.accountId);
      }
      const results = await pipeline.exec();
      if (!results || results.some(([error]) => error)) {
        throw new Error("Entryway recovery index repair failed");
      }
    }
    return stale
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, boundedLimit);
  }

  private async loadRoutesByAccountIds(accountIds: readonly string[]): Promise<Array<AccountRoute | null>> {
    const routes: Array<AccountRoute | null> = [];
    for (let offset = 0; offset < accountIds.length; offset += STALE_ROUTE_MGET_BATCH_SIZE) {
      const batch = accountIds.slice(offset, offset + STALE_ROUTE_MGET_BATCH_SIZE);
      const rawRoutes = await this.redis.mget(...batch.map((accountId) => this.routeKey(accountId)));
      for (let index = 0; index < batch.length; index += 1) {
        routes.push(safeJsonParse<AccountRoute>(rawRoutes[index] ?? null));
      }
    }
    return routes;
  }

  private routeKey(accountId: string): string {
    return `${this.prefix}:route:${accountId}`;
  }

  private usernameKey(username: string): string {
    return `${this.prefix}:username:${normalizeUsernameKey(username)}`;
  }

  private idempotencyKey(idempotencyKeyHash: string): string {
    return `${this.prefix}:idempotency:${idempotencyKeyHash}`;
  }

  private indexKey(): string {
    return `${this.prefix}:index`;
  }
}

const COMPARE_ROUTE_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok or type(current) ~= "table" then return 0 end
local next = cjson.decode(ARGV[3])
local currentRevision = tonumber(current.revision or 0)
local expectedRevision = tonumber(ARGV[1])
local currentFence = current.provisioning and current.provisioning.fenceToken or ""
local expectedFence = ARGV[2]
if currentRevision ~= expectedRevision or currentFence ~= expectedFence then return 0 end
if current.status ~= "provisioning" and current.status ~= "failed" then return 0 end
if next.accountId ~= current.accountId or current.accountId ~= ARGV[5] or
   next.username ~= current.username or
   next.createdAt ~= current.createdAt or
   next.provisioning.idempotencyKeyHash ~= current.provisioning.idempotencyKeyHash or
   next.provisioning.requestFingerprint ~= current.provisioning.requestFingerprint or
   tonumber(next.revision) ~= currentRevision + 1 then
  return 0
end
redis.call("SET", KEYS[1], ARGV[3])
if next.status == "provisioning" then
  redis.call("ZADD", KEYS[2], ARGV[4], ARGV[5])
else
  redis.call("ZREM", KEYS[2], ARGV[5])
end
return 1
`;

function isValidRouteTransition(current: AccountRoute, expected: AccountRoute, next: AccountRoute): boolean {
  const currentRevision = current.revision ?? 0;
  return current.accountId === expected.accountId &&
    current.accountId === next.accountId &&
    current.status !== "active" && current.status !== "suspended" && current.status !== "migrating" &&
    (current.status === "provisioning" || current.status === "failed") &&
    currentRevision === (expected.revision ?? 0) &&
    next.revision === currentRevision + 1 &&
    (current.provisioning.fenceToken ?? "") === (expected.provisioning.fenceToken ?? "") &&
    next.username === current.username &&
    next.createdAt === current.createdAt &&
    next.provisioning.idempotencyKeyHash === current.provisioning.idempotencyKeyHash &&
    next.provisioning.requestFingerprint === current.provisioning.requestFingerprint &&
    Number.isFinite(Date.parse(next.updatedAt));
}

const RESERVE_ROUTE_LUA = `
local idem = redis.call("GET", KEYS[1])
if idem then
  local sep = string.find(idem, ":")
  if not sep then
    return {"idempotency_conflict", ""}
  end
  local fingerprint = string.sub(idem, 1, sep - 1)
  local accountId = string.sub(idem, sep + 1)
  if fingerprint == ARGV[1] then
    return {"replayed", accountId}
  end
  return {"idempotency_conflict", accountId}
end

local existingAccountId = redis.call("GET", KEYS[2])
if existingAccountId then
  return {"username_taken", existingAccountId}
end

redis.call("SET", KEYS[3], ARGV[3])
redis.call("SET", KEYS[2], ARGV[2])
redis.call("SET", KEYS[1], ARGV[1] .. ":" .. ARGV[2])
redis.call("ZADD", KEYS[4], ARGV[4], ARGV[2])
return {"created", ARGV[2]}
`;

function normalizeUsernameKey(username: string): string {
  return username.trim().toLowerCase();
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
