/** BullMQ passes connection opts to ioredis, which has no `url` field — parse it. */
export function redisConnectionFromUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: u.password } : {}),
    // Required by BullMQ workers:
    maxRetriesPerRequest: null as null,
  };
}
