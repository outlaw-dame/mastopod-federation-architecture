import type { Redis } from "ioredis";
import { deepClone, safeJsonParse } from "./stable.js";
import type {
  AccountRoute,
  AccountRouteReservationInput,
  AccountRouteReservationResult,
  AccountRouteStore,
} from "./types.js";

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

  public async save(route: AccountRoute): Promise<void> {
    const cloned = deepClone(route);
    this.routesByAccountId.set(cloned.accountId, cloned);
    this.accountIdByUsername.set(normalizeUsernameKey(cloned.username), cloned.accountId);
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

  public async save(route: AccountRoute): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.set(this.routeKey(route.accountId), JSON.stringify(route));
    pipeline.set(this.usernameKey(route.username), route.accountId);
    pipeline.zadd(this.indexKey(), String(Date.parse(route.createdAt) || Date.now()), route.accountId);
    await pipeline.exec();
  }

  public async listStaleProvisioning(beforeIso: string, limit: number): Promise<AccountRoute[]> {
    const beforeMs = Date.parse(beforeIso);
    if (!Number.isFinite(beforeMs)) {
      return [];
    }

    const accountIds = await this.redis.zrangebyscore(
      this.indexKey(),
      "-inf",
      String(beforeMs),
      "LIMIT",
      0,
      clampLimit(limit) * 3,
    );
    const routes = await Promise.all(accountIds.map((accountId) => this.getByAccountId(accountId)));
    return routes
      .filter((route): route is AccountRoute => !!route && route.status === "provisioning")
      .filter((route) => Date.parse(route.updatedAt) < beforeMs)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, clampLimit(limit));
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
