import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canMentionEveryone,
  everyoneRecipients,
  mentionsAi,
  mentionsEveryone,
  sanitizeMentions,
} from '../groupMentions.js';

test('detects @all and @ai only as whole words at a word start', () => {
  assert.equal(mentionsEveryone('@all meeting at 5'), true);
  assert.equal(mentionsEveryone('hey @ALL please read'), true);
  assert.equal(mentionsEveryone('ping @all.'), true);
  assert.equal(mentionsEveryone('hi @allison'), false);
  assert.equal(mentionsEveryone('mail me at foo@all.com'), false);
  assert.equal(mentionsEveryone(undefined), false);

  assert.equal(mentionsAi('@ai what is 2+2?'), true);
  assert.equal(mentionsAi('thanks @AI'), true);
  assert.equal(mentionsAi('@aim high'), false);
  assert.equal(mentionsAi('me@ai.com'), false);
});

test('only group admins may mention everyone', () => {
  const base = { chatType: 'Group', adminIds: ['admin'], senderId: 'admin' };
  assert.equal(canMentionEveryone(base), true);
  assert.equal(canMentionEveryone({ ...base, senderId: 'member' }), false);
  assert.equal(canMentionEveryone({ ...base, chatType: 'DM' }), false);
  assert.equal(canMentionEveryone({ ...base, adminIds: undefined }), false);
});

test('everyone excludes the sender and muted members', () => {
  const ids = everyoneRecipients(
    [
      { userId: 'admin' },
      { userId: 'a' },
      { userId: 'b', chatSettings: { isMuted: true } },
      { userId: 'a' },
      { userId: 'c', chatSettings: { isMuted: false } },
    ],
    'admin'
  );
  assert.deepEqual(ids, ['a', 'c']);
});

test('sanitizeMentions drops forged all markers and adds the accepted one', () => {
  const forged = [{ userId: 'all', username: 'all' }, { userId: 'u1', username: 'bob' }];
  assert.deepEqual(sanitizeMentions(forged, false), [{ userId: 'u1', username: 'bob' }]);
  assert.deepEqual(sanitizeMentions(forged, true), [
    { userId: 'u1', username: 'bob' },
    { userId: 'all', username: 'all' },
  ]);
  assert.deepEqual(sanitizeMentions(undefined, false), []);
});

import { buildAiContext } from '../../lib/aiContext.js';

test('buildAiContext labels humans, keeps bot turns, and skips empty messages', () => {
  const turns = buildAiContext(
    [
      { content: 'who is free?', sender: { id: 'u1', name: 'Ada' } },
      { content: '   ', sender: { id: 'u2', name: 'Bo' } },
      { content: 'I am', sender: { id: 'u3', username: 'cy' } },
      { content: 'Ada and Cy.', sender: { id: 'bot', name: 'Velo AI' } },
      { content: '@ai summarise', sender: { id: 'u1', name: 'Ada' } },
    ],
    'bot'
  );
  assert.deepEqual(turns, [
    { role: 'user', content: 'Ada: who is free?' },
    { role: 'user', content: 'cy: I am' },
    { role: 'assistant', content: 'Ada and Cy.' },
    { role: 'user', content: 'Ada: @ai summarise' },
  ]);
});
