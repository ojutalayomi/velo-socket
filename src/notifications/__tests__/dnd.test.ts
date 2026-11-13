import assert from 'node:assert/strict';
import test from 'node:test';
import { isWithinQuietHours, mergeNotificationPreferences } from '../settings.js';
import type { DndWindow } from '../../types.js';

const overnight: DndWindow = {
  enabled: true,
  start: '22:00',
  end: '08:00',
  timezone: 'UTC',
};

test('same-day quiet hours are inclusive at the start and exclusive at the end', () => {
  const dnd: DndWindow = { ...overnight, start: '09:00', end: '17:00' };

  assert.equal(isWithinQuietHours(new Date('2026-01-01T09:00:00Z'), dnd), true);
  assert.equal(isWithinQuietHours(new Date('2026-01-01T16:59:00Z'), dnd), true);
  assert.equal(isWithinQuietHours(new Date('2026-01-01T17:00:00Z'), dnd), false);
  assert.equal(isWithinQuietHours(new Date('2026-01-01T08:59:00Z'), dnd), false);
});

test('overnight quiet hours wrap midnight', () => {
  assert.equal(isWithinQuietHours(new Date('2026-01-01T23:30:00Z'), overnight), true);
  assert.equal(isWithinQuietHours(new Date('2026-01-01T03:00:00Z'), overnight), true);
  assert.equal(isWithinQuietHours(new Date('2026-01-01T12:00:00Z'), overnight), false);
  assert.equal(isWithinQuietHours(new Date('2026-01-01T08:00:00Z'), overnight), false);
});

test('time zones shift the evaluated local time', () => {
  const zoned: DndWindow = { ...overnight, timezone: 'America/New_York' };
  // 03:00 UTC = 22:00 EST previous day
  assert.equal(isWithinQuietHours(new Date('2026-01-01T03:00:00Z'), zoned), true);
  // 15:00 UTC = 10:00 EST
  assert.equal(isWithinQuietHours(new Date('2026-01-01T15:00:00Z'), zoned), false);
});

test('disabled or empty windows never silence notifications', () => {
  assert.equal(
    isWithinQuietHours(new Date('2026-01-01T23:00:00Z'), { ...overnight, enabled: false }),
    false
  );
  assert.equal(
    isWithinQuietHours(new Date('2026-01-01T23:00:00Z'), { ...overnight, start: '22:00', end: '22:00' }),
    false
  );
});

test('settings merge defaults and repair invalid values', () => {
  assert.deepEqual(mergeNotificationPreferences(null), {
    messages: true,
    mentions: true,
    follows: true,
    calls: true,
    hideMessagePreview: false,
    dnd: { enabled: false, start: '22:00', end: '08:00', timezone: 'UTC' },
  });

  const merged = mergeNotificationPreferences({
    mentions: false,
    dnd: { enabled: true, start: '25:00', end: '07:30', timezone: 'Not/AZone' },
  });
  assert.equal(merged.mentions, false);
  assert.deepEqual(merged.dnd, {
    enabled: true,
    start: '22:00',
    end: '07:30',
    timezone: 'UTC',
  });
});
