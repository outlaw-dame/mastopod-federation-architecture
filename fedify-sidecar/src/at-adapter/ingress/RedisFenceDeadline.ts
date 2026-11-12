/**
 * Bound Redis fencing operations. ioredis may otherwise queue/retry commands
 * after connectivity loss while an external WebSocket remains authorized.
 * A timed-out operation can still complete remotely; all writes remain
 * protected by owner tokens and monotonic Redis Lua checks.
 */
export async function withRedisFenceDeadline<T>(
  operation: Promise<T>, timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    throw new Error("Invalid Redis fencing deadline");
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          "Redis fencing operation exceeded its deadline",
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
