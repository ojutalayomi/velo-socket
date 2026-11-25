import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  everyoneOpened,
  openViewOnceError,
  viewOnceDeleteAt,
  viewOnceLabel,
  viewOnceRequestError,
  VIEW_ONCE_GRACE_MS,
  VIEW_ONCE_MAX_MS,
} from '../../lib/viewOnceRules.js';

const base = { viewOnce: true, senderId: 's', userId: 'r', isMember: true, opens: {}, hasFile: true };

test('only one photo, video or voice note can be view once', () => {
  assert.equal(viewOnceRequestError({ attachmentCount: 1, mimeTypes: ['image/png'] }), null);
  assert.equal(viewOnceRequestError({ attachmentCount: 1, mimeTypes: ['audio/mpeg'] }), null);
  assert.ok(viewOnceRequestError({ attachmentCount: 2, mimeTypes: ['image/png', 'image/png'] }));
  assert.ok(viewOnceRequestError({ attachmentCount: 0, mimeTypes: [] }));
  assert.ok(viewOnceRequestError({ attachmentCount: 1, mimeTypes: ['application/pdf'] }));
});

test('a recipient can open once, nobody else can', () => {
  assert.equal(openViewOnceError(base), null);
  assert.ok(openViewOnceError({ ...base, userId: 's' }));
  assert.ok(openViewOnceError({ ...base, isMember: false }));
  assert.ok(openViewOnceError({ ...base, opens: { r: '2026-01-01' } }));
  assert.ok(openViewOnceError({ ...base, gone: true }));
  assert.ok(openViewOnceError({ ...base, hasFile: false }));
  assert.ok(openViewOnceError({ ...base, viewOnce: false }));
});

test('a group member can open even after another member has', () => {
  assert.equal(openViewOnceError({ ...base, opens: { other: '2026-01-01' } }), null);
});

test('everyoneOpened ignores the sender and needs every recipient', () => {
  assert.equal(everyoneOpened({ memberIds: ['s', 'a'], senderId: 's', opens: { a: 'x' } }), true);
  assert.equal(everyoneOpened({ memberIds: ['s', 'a', 'b'], senderId: 's', opens: { a: 'x' } }), false);
  assert.equal(everyoneOpened({ memberIds: ['s'], senderId: 's', opens: {} }), false);
});

test('delete time is soon after the last open, or 24 hours after sending', () => {
  const sent = new Date('2026-01-01T00:00:00Z');
  const opened = new Date('2026-01-01T01:00:00Z');
  assert.equal(viewOnceDeleteAt({ sentAt: sent }).getTime(), sent.getTime() + VIEW_ONCE_MAX_MS);
  assert.equal(viewOnceDeleteAt({ sentAt: sent, allOpenedAt: opened }).getTime(), opened.getTime() + VIEW_ONCE_GRACE_MS);
});

test('labels name the kind without revealing the file', () => {
  assert.match(viewOnceLabel('Image'), /View once photo/);
  assert.match(viewOnceLabel('Video'), /View once video/);
  assert.match(viewOnceLabel('VoiceNote'), /View once voice/);
});

import { isForwardable } from '../../lib/forwardRules.js';
import { payloadAttachments } from '../../lib/viewOnceRules.js';

test('a view once payload never carries its file', () => {
  const files = [{ key: 'k', url: 'https://files-for-chat.s3.amazonaws.com/k' }];
  assert.deepEqual(payloadAttachments(true, files), []);
  assert.deepEqual(payloadAttachments(false, files), files);
  assert.deepEqual(payloadAttachments(undefined, files), files);
});

test('a view once message can never be forwarded', () => {
  assert.equal(isForwardable({ content: '', attachmentCount: 0, messageType: 'Image', viewOnce: true }), false);
  assert.equal(isForwardable({ content: '', attachmentCount: 1, messageType: 'Image' }), true);
});
