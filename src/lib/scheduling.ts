/*
 * Rules for scheduled posts. The web app has a copy (velo/src/lib/scheduling.ts): keep them in step.
 */
export const MIN_SCHEDULE_AHEAD_MS = 60_000;
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** A claimed post that was never published (the server stopped mid-way) is claimed again after this long. */
export const CLAIM_TIMEOUT_MS = 5 * 60_000;

export type ScheduleCheck = { ok: true; iso: string } | { ok: false; error: string };

/** Accepts a time at least a minute away and at most a year away, and returns it as a normal ISO string. */
export function validateScheduledFor(value: unknown, now = new Date()): ScheduleCheck {
  if (typeof value !== 'string' || !value) return { ok: false, error: 'Choose a time to publish.' };
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return { ok: false, error: 'That time is not valid.' };
  const ahead = time - now.getTime();
  if (ahead < MIN_SCHEDULE_AHEAD_MS) return { ok: false, error: 'Pick a time at least a minute from now.' };
  if (ahead > MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: 'You can schedule up to a year ahead.' };
  return { ok: true, iso: new Date(time).toISOString() };
}

/** A poll that closes before the post goes live would be dead on arrival. */
export function pollOutlivesSchedule(poll: { expiresAt?: string } | undefined, scheduledIso: string): boolean {
  if (!poll?.expiresAt) return true;
  const closes = new Date(poll.expiresAt).getTime();
  return Number.isFinite(closes) && closes > new Date(scheduledIso).getTime();
}
