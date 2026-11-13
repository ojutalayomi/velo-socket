import type Redis from 'ioredis';

export const PRESENCE_ONLINE_KEY = 'presence:online';
export const PRESENCE_CONNS_KEY = 'presence:conns';
export const PRESENCE_WINDOW_MS = 30_000;
export const PRESENCE_SWEEP_INTERVAL_MS = 60_000;
const CONNS_TTL_SECONDS = 60 * 60;

/** Registers a new live connection for a user. */
export async function markConnected(redis: Redis, userId: string): Promise<void> {
  await redis
    .multi()
    .hincrby(PRESENCE_CONNS_KEY, userId, 1)
    .zadd(PRESENCE_ONLINE_KEY, Date.now(), userId)
    .expire(PRESENCE_CONNS_KEY, CONNS_TTL_SECONDS)
    .exec();
}

/** Refreshes the user's heartbeat timestamp. */
export async function heartbeat(redis: Redis, userId: string): Promise<void> {
  await redis
    .multi()
    .zadd(PRESENCE_ONLINE_KEY, Date.now(), userId)
    .expire(PRESENCE_CONNS_KEY, CONNS_TTL_SECONDS)
    .exec();
}

/** Removes one live connection; clears presence once the last one closes. */
export async function markDisconnected(redis: Redis, userId: string): Promise<void> {
  const count = await redis.hincrby(PRESENCE_CONNS_KEY, userId, -1);
  if (count > 0) return;

  await redis
    .multi()
    .hdel(PRESENCE_CONNS_KEY, userId)
    .zrem(PRESENCE_ONLINE_KEY, userId)
    .exec();
}

export async function isUserOnline(redis: Redis, userId: string): Promise<boolean> {
  const [score, count] = await Promise.all([
    redis.zscore(PRESENCE_ONLINE_KEY, userId),
    redis.hget(PRESENCE_CONNS_KEY, userId),
  ]);

  return Number(count ?? 0) > 0 && Number(score ?? 0) >= Date.now() - PRESENCE_WINDOW_MS;
}

async function readPresence(redis: Redis, userIds: string[]): Promise<Map<string, boolean>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const presence = new Map<string, boolean>();
  if (unique.length === 0) return presence;

  const pipeline = redis.pipeline();
  for (const userId of unique) {
    pipeline.zscore(PRESENCE_ONLINE_KEY, userId);
    pipeline.hget(PRESENCE_CONNS_KEY, userId);
  }

  const results = await pipeline.exec();
  const cutoff = Date.now() - PRESENCE_WINDOW_MS;

  unique.forEach((userId, index) => {
    const score = Number(results?.[index * 2]?.[1] ?? 0);
    const count = Number(results?.[index * 2 + 1]?.[1] ?? 0);
    presence.set(userId, count > 0 && score >= cutoff);
  });

  return presence;
}

export async function filterOnlineUsers(redis: Redis, userIds: string[]): Promise<string[]> {
  const presence = await readPresence(redis, userIds);
  return userIds.filter((userId) => presence.get(userId) === true);
}

export async function filterOfflineUsers(redis: Redis, userIds: string[]): Promise<string[]> {
  const presence = await readPresence(redis, userIds);
  return userIds.filter((userId) => presence.get(userId) !== true);
}

export async function getOnlineUserIds(redis: Redis): Promise<string[]> {
  const ids = await redis.zrangebyscore(
    PRESENCE_ONLINE_KEY,
    Date.now() - PRESENCE_WINDOW_MS,
    '+inf'
  );
  if (ids.length === 0) return [];

  const counts = await redis.hmget(PRESENCE_CONNS_KEY, ...ids);
  return ids.filter((_, index) => Number(counts[index] ?? 0) > 0);
}

/** Drops stale heartbeat scores and zero/negative connection counters. */
export async function sweepStale(redis: Redis): Promise<void> {
  await redis.zremrangebyscore(PRESENCE_ONLINE_KEY, '-inf', Date.now() - PRESENCE_WINDOW_MS);

  const counts = await redis.hgetall(PRESENCE_CONNS_KEY);
  const stale = Object.entries(counts)
    .filter(([, value]) => Number(value) <= 0)
    .map(([userId]) => userId);

  if (stale.length > 0) await redis.hdel(PRESENCE_CONNS_KEY, ...stale);
}

export function startPresenceSweep(redis: Redis): () => void {
  const timer = setInterval(() => {
    sweepStale(redis).catch((error) => console.error('Presence sweep failed:', error));
  }, PRESENCE_SWEEP_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
