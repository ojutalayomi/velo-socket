import assert from 'node:assert/strict';
import { test } from 'node:test';

import { senderFromAccount } from '../../lib/senderProfile.js';

test('the sender comes from the account, not from anything the client sent', () => {
  const sender = senderFromAccount('u1', {
    name: 'Ada Lovelace',
    username: 'ada',
    displayPicture: 'https://img/ada.png',
    verified: false,
  });
  assert.deepEqual(sender, {
    id: 'u1',
    name: 'Ada Lovelace',
    username: 'ada',
    displayPicture: 'https://img/ada.png',
    verified: false,
  });
});

test('verified is only true when the account says so', () => {
  assert.equal(senderFromAccount('u1', {}).verified, false);
  assert.equal(senderFromAccount('u1', { verified: true }).verified, true);
});

test('falls back to the first and last name, then the username', () => {
  assert.equal(senderFromAccount('u1', { firstname: 'Ada', lastname: 'Lovelace' }).name, 'Ada Lovelace');
  assert.equal(senderFromAccount('u1', { username: 'ada' }).name, 'ada');
});

import { mergeSender, storedSender } from '../../lib/senderProfile.js';

test('only the id is stored on a message', () => {
  assert.deepEqual(storedSender({ id: 'u1', name: 'Ada', verified: true } as { id: string }), { id: 'u1' });
});

test('a message shows the sender\'s current account, not an old copy', () => {
  const stored = { id: 'u1', name: 'Old', username: 'old', displayPicture: 'old.png', verified: true };
  assert.deepEqual(mergeSender(stored, { name: 'New', username: 'new', displayPicture: 'new.png', verified: false }), {
    id: 'u1',
    name: 'New',
    username: 'new',
    displayPicture: 'new.png',
    verified: false,
  });
});

test('a stored copy only fills in for an account that no longer exists', () => {
  assert.equal(mergeSender({ id: 'u1', name: 'Ada' }, null).name, 'Ada');
  assert.equal(mergeSender({ id: 'u1' }, null).name, 'Deleted user');
});
