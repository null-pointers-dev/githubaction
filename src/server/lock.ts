import { randomUUID } from "node:crypto";
import { redis } from "./redis";

export class LockBusyError extends Error {
  constructor(key: string) {
    super(`Lock busy: ${key}`);
    this.name = "LockBusyError";
  }
}

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Runs fn while holding a Redis lock. If another worker holds it, throws LockBusyError
 * so BullMQ retries the job with backoff; the retry re-reads fresh state.
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const ok = await redis().set(key, token, "PX", ttlMs, "NX");
  if (ok !== "OK") throw new LockBusyError(key);
  try {
    return await fn();
  } finally {
    await redis().eval(RELEASE, 1, key, token).catch(() => undefined);
  }
}
