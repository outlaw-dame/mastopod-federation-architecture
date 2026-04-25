import { EventEmitter } from "node:events";

type ValueRecord =
  | { kind: "string"; value: string; expiresAt: number | null }
  | { kind: "set"; value: Set<string>; expiresAt: number | null }
  | { kind: "sortedSet"; value: Map<string, number>; expiresAt: number | null };

interface SharedState {
  values: Map<string, ValueRecord>;
  bus: EventEmitter;
}

type MultiCommand = () => Promise<unknown>;

export class MemoryRedis {
  private readonly listeners = new Map<string, (message: string, channel: string) => void>();

  public constructor(private readonly shared: SharedState = {
    values: new Map(),
    bus: new EventEmitter(),
  }) {}

  public on(event: string, handler: (...args: unknown[]) => void): this {
    this.shared.bus.on(`redis:${event}`, handler);
    return this;
  }

  public duplicate(): MemoryRedis {
    return new MemoryRedis(this.shared);
  }

  public async get(key: string): Promise<string | null> {
    const record = this.readRecord(key);
    if (!record || record.kind !== "string") {
      return null;
    }
    return record.value;
  }

  public async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<"OK" | null> {
    let expiresAt: number | null = null;
    let nx = false;

    for (let index = 0; index < args.length; index += 1) {
      const part = args[index];
      if (part === "EX") {
        const ttl = Number(args[index + 1]);
        expiresAt = Date.now() + ttl * 1000;
        index += 1;
      } else if (part === "NX") {
        nx = true;
      }
    }

    if (nx && this.readRecord(key)) {
      return null;
    }

    this.shared.values.set(key, {
      kind: "string",
      value,
      expiresAt,
    });
    return "OK";
  }

  public async incr(key: string): Promise<number> {
    const record = this.readRecord(key);
    const current = record && record.kind === "string" ? Number.parseInt(record.value, 10) : 0;
    const nextValue = (Number.isFinite(current) ? current : 0) + 1;
    this.shared.values.set(key, {
      kind: "string",
      value: String(nextValue),
      expiresAt: record?.expiresAt ?? null,
    });
    return nextValue;
  }

  public async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      removed += this.shared.values.delete(key) ? 1 : 0;
    }
    return removed;
  }

  public async ttl(key: string): Promise<number> {
    const record = this.readRecord(key);
    if (!record) {
      return -2;
    }
    if (record.expiresAt === null) {
      return -1;
    }
    return Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 1000));
  }

  public async expire(key: string, ttlSeconds: number): Promise<number> {
    const record = this.readRecord(key);
    if (!record) {
      return 0;
    }
    record.expiresAt = Date.now() + ttlSeconds * 1000;
    return 1;
  }

  public async sadd(key: string, ...members: string[]): Promise<number> {
    let record = this.readRecord(key);
    if (!record) {
      record = { kind: "set", value: new Set<string>(), expiresAt: null };
      this.shared.values.set(key, record);
    }
    if (record.kind !== "set") {
      throw new Error(`Key ${key} is not a set`);
    }

    let added = 0;
    for (const member of members) {
      if (!record.value.has(member)) {
        record.value.add(member);
        added += 1;
      }
    }
    return added;
  }

  public async smembers(key: string): Promise<string[]> {
    const record = this.readRecord(key);
    if (!record || record.kind !== "set") {
      return [];
    }
    return Array.from(record.value).sort();
  }

  public async srem(key: string, ...members: string[]): Promise<number> {
    const record = this.readRecord(key);
    if (!record || record.kind !== "set") {
      return 0;
    }

    let removed = 0;
    for (const member of members) {
      if (record.value.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  public async publish(channel: string, message: string): Promise<number> {
    this.shared.bus.emit(`message:${channel}`, message, channel);
    return 1;
  }

  public async zadd(key: string, score: number, member: string): Promise<number> {
    let record = this.readRecord(key);
    if (!record) {
      record = { kind: "sortedSet", value: new Map<string, number>(), expiresAt: null };
      this.shared.values.set(key, record);
    }
    if (record.kind !== "sortedSet") {
      throw new Error(`Key ${key} is not a sorted set`);
    }

    const existed = record.value.has(member);
    record.value.set(member, score);
    return existed ? 0 : 1;
  }

  public async zrangebyscore(
    key: string,
    min: string,
    max: string,
    ...args: Array<string | number>
  ): Promise<string[]> {
    const record = this.readRecord(key);
    if (!record || record.kind !== "sortedSet") {
      return [];
    }

    let offset = 0;
    let count = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "LIMIT") {
        offset = Number(args[index + 1] ?? 0);
        count = Number(args[index + 2] ?? Number.MAX_SAFE_INTEGER);
        break;
      }
    }

    const entries = Array.from(record.value.entries())
      .filter(([, score]) => scoreMatchesMin(score, min) && scoreMatchesMax(score, max))
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return leftMember.localeCompare(rightMember);
      })
      .slice(offset, offset + count)
      .map(([member]) => member);

    return entries;
  }

  public async zrem(key: string, ...members: string[]): Promise<number> {
    const record = this.readRecord(key);
    if (!record || record.kind !== "sortedSet") {
      return 0;
    }

    let removed = 0;
    for (const member of members) {
      if (record.value.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  public async zremrangebyrank(key: string, start: number, stop: number): Promise<number> {
    const record = this.readRecord(key);
    if (!record || record.kind !== "sortedSet") {
      return 0;
    }

    const members = Array.from(record.value.entries())
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return leftMember.localeCompare(rightMember);
      })
      .map(([member]) => member);

    let normalizedStart = normalizeRank(start, members.length);
    let normalizedStop = normalizeRank(stop, members.length);
    if (normalizedStart === null || normalizedStop === null) {
      return 0;
    }
    if (normalizedStart < 0) {
      normalizedStart = 0;
    }
    if (normalizedStop < 0 || normalizedStart > normalizedStop) {
      return 0;
    }
    if (normalizedStop >= members.length) {
      normalizedStop = members.length - 1;
    }

    let removed = 0;
    for (const member of members.slice(normalizedStart, normalizedStop + 1)) {
      if (record.value.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  public async subscribe(channel: string): Promise<void> {
    const listener = (message: string, publishedChannel: string): void => {
      this.shared.bus.emit("redis:message", publishedChannel, message);
    };
    this.listeners.set(channel, listener);
    this.shared.bus.on(`message:${channel}`, listener);
  }

  public async unsubscribe(channel: string): Promise<void> {
    const listener = this.listeners.get(channel);
    if (!listener) {
      return;
    }
    this.shared.bus.off(`message:${channel}`, listener);
    this.listeners.delete(channel);
  }

  public multi() {
    const commands: MultiCommand[] = [];
    const self = this;
    return {
      set(key: string, value: string, ...args: Array<string | number>) {
        commands.push(() => self.set(key, value, ...args));
        return this;
      },
      del(...keys: string[]) {
        commands.push(() => self.del(...keys));
        return this;
      },
      sadd(key: string, ...members: string[]) {
        commands.push(() => self.sadd(key, ...members));
        return this;
      },
      expire(key: string, ttlSeconds: number) {
        commands.push(() => self.expire(key, ttlSeconds));
        return this;
      },
      zadd(key: string, score: number, member: string) {
        commands.push(() => self.zadd(key, score, member));
        return this;
      },
      zremrangebyrank(key: string, start: number, stop: number) {
        commands.push(() => self.zremrangebyrank(key, start, stop));
        return this;
      },
      publish(channel: string, message: string) {
        commands.push(() => self.publish(channel, message));
        return this;
      },
      exec() {
        return Promise.all(commands.map((command) => command()));
      },
    };
  }

  public async quit(): Promise<void> {
    for (const channel of this.listeners.keys()) {
      await this.unsubscribe(channel);
    }
  }

  public disconnect(): void {
    for (const [channel, listener] of this.listeners) {
      this.shared.bus.off(`message:${channel}`, listener);
    }
    this.listeners.clear();
  }

  private readRecord(key: string): ValueRecord | null {
    const record = this.shared.values.get(key);
    if (!record) {
      return null;
    }
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      this.shared.values.delete(key);
      return null;
    }
    return record;
  }
}

function scoreMatchesMin(score: number, rawMin: string): boolean {
  if (rawMin === "-inf") {
    return true;
  }
  if (rawMin.startsWith("(")) {
    return score > Number(rawMin.slice(1));
  }
  return score >= Number(rawMin);
}

function scoreMatchesMax(score: number, rawMax: string): boolean {
  if (rawMax === "+inf") {
    return true;
  }
  if (rawMax.startsWith("(")) {
    return score < Number(rawMax.slice(1));
  }
  return score <= Number(rawMax);
}

function normalizeRank(rank: number, size: number): number | null {
  if (size === 0) {
    return null;
  }

  return rank < 0 ? size + rank : rank;
}
