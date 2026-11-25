import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';

import { canReplyToStatus, statusReplyPreview } from '../../lib/statusReply.js';

const base = {
  senderId: 'fan',
  ownerId: 'owner',
  chatType: 'DM',
  receiverId: 'owner',
  expiresAt: '2026-11-26T10:00:00.000Z',
  now: new Date('2026-11-25T10:00:00.000Z'),
  senderFollowsOwner: true,
  ownerBlockedSender: false,
};

test('a follower may reply to a live status in their DM with the owner', () => {
  assert.equal(canReplyToStatus(base), true);
});

test('every other case is sent as an ordinary message', () => {
  assert.equal(canReplyToStatus({ ...base, chatType: 'Group' }), false);
  assert.equal(canReplyToStatus({ ...base, receiverId: 'someone-else' }), false);
  assert.equal(canReplyToStatus({ ...base, senderId: 'owner' }), false);
  assert.equal(canReplyToStatus({ ...base, expiresAt: '2026-11-25T09:00:00.000Z' }), false);
  assert.equal(canReplyToStatus({ ...base, senderFollowsOwner: false }), false);
  assert.equal(canReplyToStatus({ ...base, ownerBlockedSender: true }), false);
});

const status = (over: Record<string, unknown>) => ({
  _id: new ObjectId(),
  userId: 'owner',
  mediaType: 'image' as const,
  mediaUrl: 'https://post-s.s3.amazonaws.com/a.png',
  caption: '',
  expiresAt: '2026-11-26T10:00:00.000Z',
  ...over,
});

test('the preview of a photo or video keeps its file for the thumbnail', () => {
  const s = status({ caption: 'sunset' });
  const preview = statusReplyPreview(s);
  assert.deepEqual(preview, {
    statusId: s._id.toString(),
    ownerId: 'owner',
    mediaType: 'image',
    thumbUrl: 'https://post-s.s3.amazonaws.com/a.png',
    caption: 'sunset',
    expiresAt: '2026-11-26T10:00:00.000Z',
  });
});

test('the preview of a text status keeps its words and background, a voice one keeps neither', () => {
  const text = statusReplyPreview(status({ mediaType: 'text', mediaUrl: '', text: 'x'.repeat(500), background: 'ocean' }));
  assert.equal(text.text?.length, 200);
  assert.equal(text.background, 'ocean');
  assert.equal(text.thumbUrl, undefined);

  const voice = statusReplyPreview(status({ mediaType: 'audio', mediaUrl: 'https://post-s.s3.amazonaws.com/v.mp3' }));
  assert.equal(voice.thumbUrl, undefined);
  assert.equal(voice.text, undefined);
});
