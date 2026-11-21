import test from 'node:test';
import assert from 'node:assert/strict';

import { nextAttempt, readReply } from '../../lib/aiReply.js';

const reply = (content: unknown, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content } }] });

test('reads string and part-array replies', () => {
  assert.equal(readReply(reply('  hi  ')).text, 'hi');
  assert.equal(readReply(reply([{ text: 'a' }, 'b'])).text, 'a\nb');
});

test('explains an empty reply', () => {
  assert.deepEqual(readReply(reply('', 'length')), { text: '', finishReason: 'length', problem: undefined });
  assert.match(readReply({ error: { message: 'rate limited' } }).problem ?? '', /rate limited/);
  assert.equal(readReply({ choices: [] }).problem, 'no choices returned');
  assert.match(readReply({ choices: [{ message: { content: null, refusal: 'no' } }] }).problem ?? '', /refusal/);
  assert.equal(readReply(null).text, '');
});

test('retries with more tokens when the budget ran out, never after a refusal or filter', () => {
  assert.deepEqual(nextAttempt({ text: '', finishReason: 'length' }, 1000), { retry: true, tokens: 3000 });
  assert.deepEqual(nextAttempt({ text: '', finishReason: 'stop' }, 1000), { retry: true, tokens: 1000 });
  assert.equal(nextAttempt({ text: '', finishReason: 'content_filter' }, 1000).retry, false);
  assert.equal(nextAttempt({ text: '', problem: 'refusal: x' }, 1000).retry, false);
});
