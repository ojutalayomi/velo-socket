import assert from 'node:assert/strict';
import test from 'node:test';

import { canDeleteChat, messageDeletion, parseParticipantUpdates } from '../../lib/conversationUpdates.js';

test('accepts whitelisted fields and ignores the client-supplied userId', () => {
  assert.deepEqual(parseParticipantUpdates({ pinned: true, userId: 'someone-else' }), { pinned: true });
  assert.deepEqual(parseParticipantUpdates({ unreadCount: 0 }), { unreadCount: 0 });
  assert.deepEqual(parseParticipantUpdates({ archived: false, favorite: true, unreadCount: 3 }), {
    archived: false,
    favorite: true,
    unreadCount: 3,
  });
});

test('rejects unknown keys, bad types, and empty payloads', () => {
  assert.equal(parseParticipantUpdates({ chatId: 'x', pinned: true }), null);
  assert.equal(parseParticipantUpdates({ isPinned: true }), null);
  assert.equal(parseParticipantUpdates({ pinned: 'yes' }), null);
  assert.equal(parseParticipantUpdates({ unreadCount: -1 }), null);
  assert.equal(parseParticipantUpdates({ unreadCount: 1.5 }), null);
  assert.equal(parseParticipantUpdates({ unreadCount: Number.NaN }), null);
  assert.equal(parseParticipantUpdates({ userId: 'only' }), null);
  assert.equal(parseParticipantUpdates(null), null);
  assert.equal(parseParticipantUpdates([]), null);
});

test('chat deletion needs membership, plus admin for groups', () => {
  assert.equal(canDeleteChat({ chatType: 'DM', userId: 'u', isMember: true }), true);
  assert.equal(canDeleteChat({ chatType: 'DM', userId: 'u', isMember: false }), false);
  assert.equal(canDeleteChat({ chatType: 'Group', adminIds: ['a'], userId: 'a', isMember: true }), true);
  assert.equal(canDeleteChat({ chatType: 'Group', adminIds: ['a'], userId: 'm', isMember: true }), false);
  assert.equal(canDeleteChat({ chatType: 'Group', userId: 'm', isMember: true }), false);
});

test('only the sender can delete a message for everyone', () => {
  assert.equal(messageDeletion({ senderId: 'u', userId: 'u' }), 'sender');
  assert.equal(messageDeletion({ senderId: 'u', userId: 'u', chatType: 'Group', adminIds: ['u'] }), 'sender');
  assert.equal(messageDeletion({ senderId: 'u', userId: 'x' }), null);
  assert.equal(messageDeletion({ senderId: 'u', userId: 'x', chatType: 'Group', adminIds: ['a'] }), null);
  assert.equal(messageDeletion({ senderId: 'u', userId: 'a', chatType: 'Group', adminIds: ['a'] }), 'admin');
  // A DM has no admins, whatever the stored adminIds say.
  assert.equal(messageDeletion({ senderId: 'u', userId: 'a', chatType: 'DM', adminIds: ['a'] }), null);
  assert.equal(messageDeletion({ userId: 'x' }), null);
});

import { canSendMessage } from '../../lib/chatPermissions.js';

test('restricted groups only accept messages from admins', () => {
  const group = { chatType: 'Group', onlyAdminsCanSend: true, adminIds: ['a'] };
  assert.equal(canSendMessage({ ...group, userId: 'm' }), false);
  assert.equal(canSendMessage({ ...group, userId: 'a' }), true);
  assert.equal(canSendMessage({ ...group, onlyAdminsCanSend: false, userId: 'm' }), true);
  assert.equal(canSendMessage({ chatType: 'DM', onlyAdminsCanSend: true, userId: 'm' }), true);
});
