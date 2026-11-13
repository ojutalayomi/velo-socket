import type Redis from 'ioredis';
import type { NotificationKind } from './eligibility.js';

const DEDUP_TTL_SECONDS: Record<NotificationKind | 'call-incoming' | 'call-missed' | 'call-close', number> = {
  message: 300,
  mention: 300,
  follow: 60,
  call: 300,
  'call-incoming': 300,
  'call-missed': 300,
  'call-close': 300,
};

export type DedupKind = keyof typeof DEDUP_TTL_SECONDS;

export function dedupTtl(kind: DedupKind): number {
  return DEDUP_TTL_SECONDS[kind];
}

/**
 * Atomically claims a push slot per recipient. Returns the recipients that won
 * the claim; duplicates (or missing source ids) are dropped.
 */
export async function claimBatch(
  redis: Redis,
  kind: DedupKind,
  userIds: string[],
  sourceId?: string
): Promise<string[]> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return [];
  if (!sourceId) return unique;

  const ttl = dedupTtl(kind);
  const pipeline = redis.pipeline();
  for (const userId of unique) {
    pipeline.set(`push:dedup:${kind}:${userId}:${sourceId}`, '1', 'EX', String(ttl), 'NX');
  }

  const results = await pipeline.exec();
  return unique.filter((_, index) => results?.[index]?.[1] === 'OK');
}
