import assert from 'node:assert/strict';
import test from 'node:test';

import { canPinMessages, MAX_PINNED_MESSAGES, planPin, planUnpin } from '../../lib/pinRules.js';

const now = new Date('2026-11-25T10:00:00.000Z');

test('either person pins in a DM, only admins in a group or channel', () => {
  assert.equal(canPinMessages({ chatType: 'DM', userId: 'a' }), true);
  assert.equal(canPinMessages({ chatType: 'Personal', userId: 'a' }), true);
  assert.equal(canPinMessages({ chatType: 'Group', adminIds: ['a'], userId: 'a' }), true);
  assert.equal(canPinMessages({ chatType: 'Group', adminIds: ['a'], userId: 'b' }), false);
  assert.equal(canPinMessages({ chatType: 'Group', userId: 'b' }), false);
  assert.equal(canPinMessages({ chatType: 'Channels', adminIds: ['a'], userId: 'b' }), false);
});

test('pins go on the front, newest first', () => {
  const first = planPin([], 'm1', 'a', now);
  assert.ok(first.ok);
  const second = planPin(first.pins, 'm2', 'b', now);
  assert.ok(second.ok && second.changed);
  assert.deepEqual(second.pins.map((p) => p.messageId), ['m2', 'm1']);
  assert.equal(second.pins[0].pinnedBy, 'b');
  assert.equal(second.pins[0].pinnedAt, now.toISOString());
});

test('pinning what is already pinned changes nothing', () => {
  const first = planPin(undefined, 'm1', 'a', now);
  assert.ok(first.ok);
  const again = planPin(first.pins, 'm1', 'b', now);
  assert.ok(again.ok);
  assert.equal(again.changed, false);
  assert.deepEqual(again.pins, first.pins);
});

test('stops at the limit, and says to unpin one', () => {
  let pins = [] as ReturnType<typeof planUnpin>['pins'];
  for (let i = 0; i < MAX_PINNED_MESSAGES; i++) {
    const plan = planPin(pins, `m${i}`, 'a', now);
    assert.ok(plan.ok);
    pins = plan.pins;
  }
  assert.equal(pins.length, MAX_PINNED_MESSAGES);
  const over = planPin(pins, 'extra', 'a', now);
  assert.equal(over.ok, false);
  assert.match(over.ok ? '' : over.error, /Unpin one first/);
  assert.equal(planPin(pins, 'm0', 'a', now).ok, true); // already there: still fine
});

test('unpinning removes just that message, and nothing if it was not pinned', () => {
  const a = planPin([], 'm1', 'a', now);
  assert.ok(a.ok);
  const b = planPin(a.pins, 'm2', 'a', now);
  assert.ok(b.ok);
  const removed = planUnpin(b.pins, 'm1');
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.pins.map((p) => p.messageId), ['m2']);
  assert.equal(planUnpin(removed.pins, 'zzz').changed, false);
  assert.equal(planUnpin(undefined, 'm1').changed, false);
});

test('the limit is at least four', () => {
  assert.ok(MAX_PINNED_MESSAGES >= 4);
});
