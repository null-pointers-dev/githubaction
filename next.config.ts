import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // BullMQ ships Lua scripts read from disk, and pg/ioredis use native sockets:
  // keep them out of the server bundle.
  serverExternalPackages: ["bullmq", "ioredis", "pg"],
};

export default nextConfig;
