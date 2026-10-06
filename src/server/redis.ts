import { Redis } from "ioredis";
import type { RedisOptions } from "bullmq";
import { config } from "./config";

/** Connection options for BullMQ (it creates its own connections from these). */
export function redisOptions(): RedisOptions {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    // Required by BullMQ for blocking connections.
    maxRetriesPerRequest: null,
  };
}

const g = globalThis as unknown as { __fdRedis?: Redis };

/** Shared client for commands and publishing. */
export function redis(): Redis {
  if (!g.__fdRedis) g.__fdRedis = new Redis(redisOptions());
  return g.__fdRedis;
}

/** Dedicated client, e.g. for a subscriber connection. Caller must quit() it. */
export function newRedis(): Redis {
  return new Redis(redisOptions());
}

export const KEYS = {
  pollerLast: "fd:poller:last",
  webhookLast: "fd:webhook:last",
  rateLimit: "fd:ratelimit",
  redeliveryCheckpoint: "fd:redelivery:checkpoint",
};
