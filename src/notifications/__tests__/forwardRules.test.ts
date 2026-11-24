import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';

import { isForwardable, MAX_FORWARD_CHATS, MAX_FORWARD_MESSAGES, parseForwardRequest } from '../../lib/forwardRules.js';

const id = () => new ObjectId().toString();

test('accepts valid ids and removes duplicates', () => {
  const a = id();
  const c = id();
  const result = parseForwardRequest({ messageIds: [a, a], chatIds: [c] });
  assert.deepEqual(result, { ok: true, messageIds: [a], chatIds: [c] });
});

test('rejects malformed, empty and oversized requests', () => {
  assert.equal(parseForwardRequest(null).ok, false);
  assert.equal(parseForwardRequest({ messageIds: ['nope'], chatIds: [id()] }).ok, false);
  assert.equal(parseForwardRequest({ messageIds: [], chatIds: [id()] }).ok, false);
  assert.equal(parseForwardRequest({ messageIds: [id()], chatIds: [] }).ok, false);
  assert.equal(parseForwardRequest({ messageIds: [{}], chatIds: [id()] }).ok, false);

  const tooManyMessages = Array.from({ length: MAX_FORWARD_MESSAGES + 1 }, id);
  assert.equal(parseForwardRequest({ messageIds: tooManyMessages, chatIds: [id()] }).ok, false);
  const tooManyChats = Array.from({ length: MAX_FORWARD_CHATS + 1 }, id);
  assert.equal(parseForwardRequest({ messageIds: [id()], chatIds: tooManyChats }).ok, false);
});

test('deleted and empty messages are not forwardable', () => {
  assert.equal(isForwardable({ content: 'hello', attachmentCount: 0 }), true);
  assert.equal(isForwardable({ content: '', attachmentCount: 2 }), true);
  assert.equal(isForwardable({ content: 'You deleted this message.≤≤≤', attachmentCount: 0 }), false);
  assert.equal(isForwardable({ content: '   ', attachmentCount: 0 }), false);
  assert.equal(isForwardable({ attachmentCount: 0 }), false);
});

test('calls, polls and announcements are not forwardable, other types are', () => {
  for (const messageType of ['Call', 'Poll', 'PollResponse', 'PollEnd', 'PollResult', 'Announcement']) {
    assert.equal(isForwardable({ content: 'x', attachmentCount: 0, messageType }), false, messageType);
  }
  for (const messageType of ['Text', 'Markdown', 'Image', 'VoiceNote', 'Location', 'Contact', 'Sticker', 'AnimatedGIF', 'Link']) {
    assert.equal(isForwardable({ content: 'x', attachmentCount: 0, messageType }), true, messageType);
  }
});
