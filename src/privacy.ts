import { MongoDBClient } from './mongodb.js';

export interface PrivacySettings {
  showOnlineStatus: boolean;
  showLastSeen: boolean;
  showReadReceipts: boolean;
  showTypingStatus: boolean;
}

const DEFAULTS: PrivacySettings = {
  showOnlineStatus: true,
  showLastSeen: true,
  showReadReceipts: true,
  showTypingStatus: true,
};

// Short-lived per-instance cache so hot paths (typing events) don't hit the DB each time.
// Entries are dropped on `updateSettings`; other instances pick changes up within the TTL.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: PrivacySettings; expires: number }>();

function fromDoc(doc: Record<string, unknown> | null): PrivacySettings {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof PrivacySettings)[]) {
    if (typeof doc?.[key] === 'boolean') out[key] = doc[key] as boolean;
  }
  return out;
}

export async function getPrivacy(userId: string): Promise<PrivacySettings> {
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const db = await new MongoDBClient().init();
  const doc = (await db.userSettings().findOne({ userId })) as Record<string, unknown> | null;
  const value = fromDoc(doc);
  cache.set(userId, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

export function invalidatePrivacy(userId: string) {
  cache.delete(userId);
}

/** Drops users who have switched "Show online status" off. */
export async function filterVisibleOnline(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return userIds;
  const db = await new MongoDBClient().init();
  const hidden = await db
    .userSettings()
    .find({ userId: { $in: userIds }, showOnlineStatus: false } as object, { projection: { userId: 1 } })
    .toArray();
  const hiddenIds = new Set(hidden.map((doc) => String((doc as { userId?: string }).userId)));
  return userIds.filter((id) => !hiddenIds.has(id));
}
