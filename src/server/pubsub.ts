import { redis } from "./redis";

/** Topics: "runs", "approvals", "run-<runRequestId>". */
export async function publish(topic: string, data: Record<string, unknown> = {}) {
  try {
    await redis().publish(`fd:${topic}`, JSON.stringify({ ...data, at: Date.now() }));
  } catch (err) {
    console.error("[pubsub] publish failed", topic, err);
  }
}

export const TOPIC_PATTERN = /^(runs|approvals|run-[0-9a-f-]{36})$/;
