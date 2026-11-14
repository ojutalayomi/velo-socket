import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeRegex,
  extractMentionUsernames,
  resolveMentionedUsers,
} from '../mentions.js';
import type { MongoDBClient } from '../../mongodb.js';

function fakeDb(users: Array<Record<string, unknown>>): MongoDBClient {
  return {
    users: () => ({
      find: (filter: { username: RegExp }) => ({
        toArray: async () => users.filter((user) => filter.username.test(String(user.username))),
      }),
    }),
  } as unknown as MongoDBClient;
}

test('extracts unique lowercase usernames in order', () => {
  assert.deepEqual(
    extractMentionUsernames('Hey @Alex and @sam, cc @ALEX @sam_2.'),
    ['alex', 'sam', 'sam_2']
  );
});

test('ignores emails and over-long usernames', () => {
  assert.deepEqual(
    extractMentionUsernames(`mail me at me@example.com @${'a'.repeat(31)} @ok`),
    ['ok']
  );
});

test('caps mentions at twenty', () => {
  const caption = Array.from({ length: 25 }, (_, index) => `@user${index}`).join(' ');
  assert.equal(extractMentionUsernames(caption).length, 20);
});

test('returns an empty list for missing captions', () => {
  assert.deepEqual(extractMentionUsernames(undefined), []);
  assert.deepEqual(extractMentionUsernames(null), []);
  assert.deepEqual(extractMentionUsernames(''), []);
});

test('escapes regular expression metacharacters', () => {
  assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
});

test('resolves usernames case-insensitively and escapes the pattern', async () => {
  const db = fakeDb([
    {
      _id: '1',
      username: 'Alex',
      firstname: 'Alex',
      lastname: 'Johnson',
      displayPicture: 'alex.png',
      verified: true,
    },
    {
      _id: '2',
      username: 'sam',
      firstname: '',
      lastname: '',
      displayPicture: '',
      verified: false,
    },
  ]);

  const actors = await resolveMentionedUsers(db, ['alex', 'sam']);
  assert.equal(actors.length, 2);

  const alex = actors.find((actor) => actor.username === 'Alex');
  assert.equal(alex?.id, '1');
  assert.equal(alex?.name, 'Alex Johnson');
  assert.equal(alex?.verified, true);

  const sam = actors.find((actor) => actor.username === 'sam');
  assert.equal(sam?.name, 'sam');
});

test('treats regex characters in usernames literally', async () => {
  const db = fakeDb([
    { _id: '1', username: 'a.b', firstname: 'Dot', verified: false },
    { _id: '2', username: 'axb', firstname: 'Wildcard', verified: false },
  ]);

  const actors = await resolveMentionedUsers(db, ['a.b']);
  assert.deepEqual(
    actors.map((actor) => actor.username),
    ['a.b']
  );
});
