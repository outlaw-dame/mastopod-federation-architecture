/**
 * Bounded Redis Streams admission for Redis 8.2+ work queues.
 *
 * ACKED reclamation never removes unread or pending work. An atomic XLEN
 * guard rejects producers at capacity instead of evicting in-flight jobs.
 * Delayed promotions and fanout scripts must obey the same admission contract.
 */
export const REDIS_STREAM_BACKPRESSURE_ERROR = "REDIS_STREAM_AT_CAPACITY";

export interface SafeStreamRedis {
  eval(script: string, options: {
    keys: string[];
    arguments: string[];
  }): Promise<unknown>;
  info(section: string): Promise<string>;
}

/** This is an opt-in rollout: never send Redis 8.2 syntax to Redis 7. */
export function ackedStreamRetentionRequested(): boolean {
  return process.env["REDIS_STREAM_ACKED_RETENTION"] === "true";
}

export async function requireRedis82AckedSupport(
  redis: Pick<SafeStreamRedis, "info">,
): Promise<void> {
  const result = await redis.info("server");
  const m = /^redis_version:(\d+)\.(\d+)\.(\d+)/m.exec(result);
  if (!m) throw new Error("Unable to establish Redis Streams server version");
  const major = Number(m[1]), minor = Number(m[2]);
  if (major < 8 || (major === 8 && minor < 2)) {
    throw new Error("REDIS_STREAM_ACKED_RETENTION requires Redis >= 8.2");
  }
}

/** Lua fragment for use by other atomic Redis queue producers.
 * Args are an integer capacity and the number of records to append.
 */
export const REDIS_ACKED_PREPARE_LUA = String.raw`
local function prepareAckedQueue(key, capacity, count, allowTrim)
  if capacity < 1 or count < 1 or count > capacity then
    error('Invalid work queue batch or capacity')
  end
  if allowTrim then
    -- With no consumer group, ACKED trimming cannot protect unread work.
    local groups = redis.pcall('XINFO', 'GROUPS', key)
    if type(groups) ~= 'table' or #groups == 0 then
      error('REDIS_STREAM_NO_CONSUMER_GROUP')
    end
    -- Redis 8.2: reclaim only work acknowledged by all groups.
    redis.call('XTRIM', key, 'MAXLEN', '=', tostring(capacity - count), 'ACKED')
  end
  if redis.call('XLEN', key) > capacity - count then
    error('REDIS_STREAM_AT_CAPACITY')
  end
  return 1
end
`;

const SAFE_STREAM_BATCH_SCRIPT = REDIS_ACKED_PREPARE_LUA + String.raw`
local cap = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local trim = ARGV[3] == '1'
prepareAckedQueue(KEYS[1], cap, count, trim)
local offset = 4
local ids = {}
for i = 1, count do
  local fieldCount = tonumber(ARGV[offset])
  if not fieldCount or fieldCount < 1 or fieldCount > 64 then
    error('Invalid Redis Stream field count')
  end
  offset = offset + 1
  local args = { KEYS[1], '*' }
  for f = 1, fieldCount do
    table.insert(args, ARGV[offset])
    table.insert(args, ARGV[offset + 1])
    offset = offset + 2
  end
  ids[i] = redis.call('XADD', unpack(args))
end
return ids
`;

/** An atomic, bounded enqueue. DLQ uses allowTrim=false so that unreviewed
 * dead letters are never discarded merely because no group has read them.
 */
export async function appendAcknowledgedStreamBatch(
  redis: Pick<SafeStreamRedis, "eval">,
  streamKey: string,
  records: Array<Record<string, string>>,
  capacity: number,
  allowTrim = true,
): Promise<string[]> {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000_000) {
    throw new Error("Invalid Redis Stream capacity");
  }
  if (records.length === 0) return [];
  if (records.length > 250 || records.length > capacity) {
    throw new Error("Redis Stream batch exceeds bounded admission capacity");
  }
  const args = [String(capacity), String(records.length), allowTrim ? "1" : "0"];
  for (const record of records) {
    const fields = Object.entries(record);
    if (fields.length < 1 || fields.length > 64 ||
        fields.some(([k,v]) => !k || typeof v !== "string")) {
      throw new Error("Redis Stream record must have bounded string fields");
    }
    args.push(String(fields.length));
    for (const [key, value] of fields) args.push(key, value);
  }
  const result = await redis.eval(SAFE_STREAM_BATCH_SCRIPT, {
    keys: [streamKey], arguments: args,
  });
  if (!Array.isArray(result) || result.length !== records.length ||
      !result.every(id => typeof id === "string")) {
    throw new Error("Unexpected Redis Streams admission result");
  }
  return result as string[];
}

/** A queue-capacity refusal is transient infrastructure backpressure,
 * not a business delivery failure or a reason to consume retry attempts.
 */
export function isRedisStreamCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(REDIS_STREAM_BACKPRESSURE_ERROR);
}
