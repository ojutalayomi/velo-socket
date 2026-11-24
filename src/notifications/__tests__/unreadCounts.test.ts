import assert from 'node:assert/strict';
import test from 'node:test';

import { unreadIncrement } from '../../lib/unreadCounts.js';

test('a new message is unread for everyone except its sender', () => {
  assert.equal(unreadIncrement('recipient', 'sender'), 1);
  assert.equal(unreadIncrement('sender', 'sender'), 0);
});

test('ids are compared as text', () => {
  assert.equal(unreadIncrement('5', 5 as unknown as string), 0);
});

test('with no known sender everyone gets the increment', () => {
  assert.equal(unreadIncrement('anyone', undefined), 1);
});
