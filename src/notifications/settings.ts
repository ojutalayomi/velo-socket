import { MongoDBClient } from '../mongodb.js';
import type { DndWindow, NotificationPreferences } from '../types.js';

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  messages: true,
  mentions: true,
  follows: true,
  calls: true,
  dnd: {
    enabled: false,
    start: '22:00',
    end: '08:00',
    timezone: 'UTC',
  },
  hideMessagePreview: false,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;

  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function mergeNotificationPreferences(raw: unknown): NotificationPreferences {
  const candidate =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawDnd =
    candidate.dnd && typeof candidate.dnd === 'object' && !Array.isArray(candidate.dnd)
      ? (candidate.dnd as Record<string, unknown>)
      : {};

  return {
    messages: typeof candidate.messages === 'boolean' ? candidate.messages : true,
    mentions: typeof candidate.mentions === 'boolean' ? candidate.mentions : true,
    follows: typeof candidate.follows === 'boolean' ? candidate.follows : true,
    calls: typeof candidate.calls === 'boolean' ? candidate.calls : true,
    hideMessagePreview:
      typeof candidate.hideMessagePreview === 'boolean' ? candidate.hideMessagePreview : false,
    dnd: {
      enabled: typeof rawDnd.enabled === 'boolean' ? rawDnd.enabled : false,
      start: isValidTimeOfDay(rawDnd.start) ? rawDnd.start : DEFAULT_NOTIFICATION_PREFERENCES.dnd.start,
      end: isValidTimeOfDay(rawDnd.end) ? rawDnd.end : DEFAULT_NOTIFICATION_PREFERENCES.dnd.end,
      timezone: isValidTimezone(rawDnd.timezone)
        ? rawDnd.timezone
        : DEFAULT_NOTIFICATION_PREFERENCES.dnd.timezone,
    },
  };
}

function minutesInZone(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isWithinQuietHours(now: Date, dnd: DndWindow): boolean {
  if (!dnd.enabled || !isValidTimeOfDay(dnd.start) || !isValidTimeOfDay(dnd.end)) {
    return false;
  }

  const start = toMinutes(dnd.start);
  const end = toMinutes(dnd.end);
  if (start === end) return false;

  const current = minutesInZone(now, isValidTimezone(dnd.timezone) ? dnd.timezone : 'UTC');
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Batch-loads preferences for candidate recipients; missing settings fall back to defaults. */
export async function loadNotificationPreferences(
  db: MongoDBClient,
  userIds: string[]
): Promise<Map<string, NotificationPreferences>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const preferences = new Map<string, NotificationPreferences>();
  if (unique.length === 0) return preferences;

  const rows = await db
    .userSettings()
    .find({ userId: { $in: unique } }, { projection: { userId: 1, notifications: 1 } })
    .toArray();

  for (const row of rows) {
    if (row.userId) preferences.set(row.userId, mergeNotificationPreferences(row.notifications));
  }
  for (const userId of unique) {
    if (!preferences.has(userId)) {
      preferences.set(userId, mergeNotificationPreferences(null));
    }
  }

  return preferences;
}
