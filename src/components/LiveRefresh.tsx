"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** Re-renders the current server page when any of the topics publish. */
export function LiveRefresh({ topics }: { topics: string[] }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = topics.join(",");

  useEffect(() => {
    const es = new EventSource(`/api/v1/stream?topics=${encodeURIComponent(key)}`);
    es.onmessage = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 600);
    };
    // Fallback in case the stream is blocked by a proxy.
    const poll = setInterval(() => router.refresh(), 30_000);
    return () => {
      es.close();
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, router]);

  return null;
}
