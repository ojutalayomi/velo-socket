import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReplyToPost,
  canViewPost,
  normalizeVisibility,
  readableFilter,
  replyPolicy,
  resolveAudience,
  visibleToFilter,
} from '../../lib/postVisibility.js';

const post = (Visibility: unknown, extra: Record<string, unknown> = {}) => ({ Visibility, UserId: 'owner', ...extra });

test('old and unknown values stay public; only friends and me restrict', () => {
  assert.equal(normalizeVisibility('everyone'), 'everyone');
  assert.equal(normalizeVisibility('none'), 'everyone');
  assert.equal(normalizeVisibility(undefined), 'everyone');
  assert.equal(normalizeVisibility('friends'), 'friends');
  assert.equal(normalizeVisibility('me'), 'me');
});

test('a new post has its replies derived from its visibility, old clients included', () => {
  assert.deepEqual(resolveAudience({ Visibility: 'everyone', WhoCanComment: 'none' }), { Visibility: 'everyone', WhoCanComment: 'everyone' });
  assert.deepEqual(resolveAudience({ Visibility: 'friends' }), { Visibility: 'friends', WhoCanComment: 'friends' });
  assert.deepEqual(resolveAudience({ Visibility: 'me' }), { Visibility: 'me', WhoCanComment: 'none' });
  // An old client's "none" meant replies off on a public post.
  assert.deepEqual(resolveAudience({ Visibility: 'none' }), { Visibility: 'everyone', WhoCanComment: 'none' });
  assert.deepEqual(resolveAudience({ Visibility: 'bogus' }), { Visibility: 'everyone', WhoCanComment: 'everyone' });
});

test('who can see a post', () => {
  assert.equal(canViewPost(post('everyone'), undefined, false), true);
  assert.equal(canViewPost(post('none'), 'stranger', false), true);
  assert.equal(canViewPost(post('friends'), undefined, false), false);
  assert.equal(canViewPost(post('friends'), 'stranger', false), false);
  assert.equal(canViewPost(post('friends'), 'friend', true), true);
  assert.equal(canViewPost(post('friends'), 'owner', false), true);
  assert.equal(canViewPost(post('me'), 'friend', true), false);
  assert.equal(canViewPost(post('me'), 'owner', false), true);
});

test('who can reply', () => {
  assert.equal(canReplyToPost(post('everyone'), 'stranger', false), true);
  assert.equal(canReplyToPost(post('everyone'), undefined, false), false);
  assert.equal(canReplyToPost(post('friends'), 'stranger', false), false);
  assert.equal(canReplyToPost(post('friends'), 'friend', true), true);
  assert.equal(canReplyToPost(post('me'), 'friend', true), false);
  assert.equal(canReplyToPost(post('me'), 'owner', false), true);
  // Old post: public, replies off. The author may still answer their own thread.
  const old = post('none', { WhoCanComment: 'none' });
  assert.equal(replyPolicy(old), 'none');
  assert.equal(canReplyToPost(old, 'stranger', false), false);
  assert.equal(canReplyToPost(old, 'owner', false), true);
});

test('the read filter keeps restricted and unpublished posts out of lists', () => {
  assert.deepEqual(visibleToFilter(undefined, ['m1']), { $or: [{ Visibility: { $nin: ['friends', 'me'] } }] });
  assert.deepEqual(visibleToFilter('v', []), { $or: [{ Visibility: { $nin: ['friends', 'me'] } }, { UserId: 'v' }] });
  assert.deepEqual(visibleToFilter('v', ['m1']).$or[2], { Visibility: 'friends', UserId: { $in: ['m1'] } });
  const prefixed = readableFilter('v', [], 'post') as unknown as { $and: [unknown, { $or: unknown[] }] };
  assert.deepEqual(prefixed.$and[0], { 'post.scheduledFor': { $exists: false } });
  assert.deepEqual(prefixed.$and[1].$or[1], { 'post.UserId': 'v' });
});
