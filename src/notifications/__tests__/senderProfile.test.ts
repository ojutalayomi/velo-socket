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
