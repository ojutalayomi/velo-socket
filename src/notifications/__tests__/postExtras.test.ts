import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeLocation, sanitizePoll } from '../../lib/postExtras.js';

test('sanitizePoll trims, dedupes and enforces option bounds', () => {
  const poll = sanitizePoll({ question: ' Best? ', options: ['A', 'a', ' B ', ''], multiple: true });
  assert.deepEqual(poll, { question: 'Best?', options: ['A', 'B'], multiple: true });
  assert.equal(sanitizePoll({ question: 'Q', options: ['only'] }), null);
  assert.equal(sanitizePoll({ question: 'Q', options: Array.from({ length: 7 }, (_, i) => `o${i}`) }), null);
  assert.equal(sanitizePoll({ question: '', options: ['a', 'b'] }), null);
  assert.equal(sanitizePoll('nope'), null);
});

test('sanitizeLocation requires a name and drops invalid coordinates', () => {
  assert.deepEqual(sanitizeLocation({ name: 'Lagos', lat: 6.5, lng: 3.4 }), { name: 'Lagos', lat: 6.5, lng: 3.4 });
  assert.deepEqual(sanitizeLocation({ name: 'Lagos', lat: 999, lng: 3 }), { name: 'Lagos' });
  assert.equal(sanitizeLocation({ name: '  ' }), null);
});

import { canonicalPollContent, messageDisplayText } from '../../lib/postExtras.js';

test('canonicalPollContent accepts only valid poll JSON', () => {
  const ok = canonicalPollContent(JSON.stringify({ question: ' Q ', options: ['a', 'b'], multiple: false, extra: 1 }));
  assert.equal(ok, JSON.stringify({ question: 'Q', options: ['a', 'b'], multiple: false }));
  assert.equal(canonicalPollContent('not json'), null);
  assert.equal(canonicalPollContent(JSON.stringify({ question: 'Q', options: ['a'] })), null);
  assert.equal(canonicalPollContent(42), null);
});

test('messageDisplayText hides poll JSON but leaves other content alone', () => {
  const content = JSON.stringify({ question: 'Lunch?', options: ['a', 'b'], multiple: false });
  assert.equal(messageDisplayText('Poll', content), '📊 Lunch?');
  assert.equal(messageDisplayText('Markdown', content), content);
  assert.equal(messageDisplayText('Poll', 'garbage'), 'garbage');
});
