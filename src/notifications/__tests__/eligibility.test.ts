import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRecipients } from '../eligibility.js';
import type { NotificationPreferences } from '../../types.js';

function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    messages: true,
    mentions: true,
    follows: true,
    calls: true,
    hideMessagePreview: false,
    dnd: { enabled: false, start: '22:00', end: '08:00', timezone: 'UTC' },
    ...overrides,
  };
}

function preferenceMap(
  ids: string[],
  overrides: Partial<NotificationPreferences> = {}
): Map<string, NotificationPreferences> {
  return new Map(ids.map((id) => [id, prefs(overrides)]));
}

const base = {
  candidates: ['recipient'],
  senderId: 'sender',
  kind: 'message' as const,
  participants: new Set(['sender', 'recipient']),
  blocked: new Set<string>(),
  preferences: preferenceMap(['recipient']),
  muted: new Set<string>(),
  online: new Set<string>(),
  requireOffline: true,
  now: new Date('2026-01-01T12:00:00Z'),
};

test('never notifies the sender', () => {
  assert.deepEqual(selectRecipients({ ...base, candidates: ['sender'] }), []);
});

test('skips users who are not participants', () => {
  assert.deepEqual(
    selectRecipients({
      ...base,
      candidates: ['recipient', 'stranger'],
      preferences: preferenceMap(['recipient', 'stranger']),
    }),
    ['recipient']
  );
});

test('skips recipients who blocked the sender', () => {
  assert.deepEqual(selectRecipients({ ...base, blocked: new Set(['recipient']) }), []);
});

test('respects per-type settings', () => {
  assert.deepEqual(
    selectRecipients({ ...base, preferences: preferenceMap(['recipient'], { messages: false }) }),
    []
  );
  assert.deepEqual(
    selectRecipients({
      ...base,
      kind: 'mention',
      preferences: preferenceMap(['recipient'], { mentions: false }),
    }),
    []
  );
  assert.deepEqual(
    selectRecipients({
      ...base,
      kind: 'follow',
      preferences: preferenceMap(['recipient'], { follows: false }),
    }),
    []
  );
  assert.deepEqual(
    selectRecipients({
      ...base,
      kind: 'call',
      preferences: preferenceMap(['recipient'], { calls: false }),
    }),
    []
  );
});

test('requires offline recipients unless relaxed', () => {
  assert.deepEqual(selectRecipients({ ...base, online: new Set(['recipient']) }), []);
  assert.deepEqual(
    selectRecipients({ ...base, online: new Set(['recipient']), requireOffline: false }),
    ['recipient']
  );
});

test('mute suppresses messages but not mentions', () => {
  assert.deepEqual(selectRecipients({ ...base, muted: new Set(['recipient']) }), []);

  assert.deepEqual(
    selectRecipients({
      ...base,
      kind: 'mention',
      muted: new Set(['recipient']),
    }),
    ['recipient']
  );
});

test('quiet hours suppress messages and follows but calls bypass', () => {
  const quiet = prefs({
    dnd: { enabled: true, start: '11:00', end: '13:00', timezone: 'UTC' },
  });
  const preferences = new Map([['recipient', quiet]]);

  assert.deepEqual(selectRecipients({ ...base, preferences }), []);
  assert.deepEqual(
    selectRecipients({ ...base, kind: 'follow', preferences }),
    []
  );
  assert.deepEqual(
    selectRecipients({ ...base, kind: 'call', preferences }),
    ['recipient']
  );
});

test('quiet hours respect the recipient time zone', () => {
  const zoned = prefs({
    dnd: { enabled: true, start: '22:00', end: '08:00', timezone: 'America/New_York' },
  });
  const preferences = new Map([['recipient', zoned]]);
  // 03:00 UTC = 22:00 EST
  assert.deepEqual(
    selectRecipients({ ...base, preferences, now: new Date('2026-01-01T03:00:00Z') }),
    []
  );
  // 15:00 UTC = 10:00 EST
  assert.deepEqual(
    selectRecipients({ ...base, preferences, now: new Date('2026-01-01T15:00:00Z') }),
    ['recipient']
  );
});

test('deduplicates candidate ids', () => {
  assert.deepEqual(
    selectRecipients({ ...base, candidates: ['recipient', 'recipient', ''] }),
    ['recipient']
  );
});
