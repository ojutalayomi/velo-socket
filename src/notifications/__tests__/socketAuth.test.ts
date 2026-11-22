import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { verifySocketToken } from '../../lib/socketAuth.js';

const SECRET = 'test-secret';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(claims: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }) {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const now = Date.now();
const valid = { sub: 'u1', aud: 'velo-socket', exp: Math.floor(now / 1000) + 600 };

test('a valid token gives its user id', () => {
  assert.equal(verifySocketToken(sign(valid), SECRET, now), 'u1');
});

test('rejects a token signed with another secret', () => {
  assert.equal(verifySocketToken(sign(valid, 'other'), SECRET, now), null);
});

test('rejects an altered payload', () => {
  const [h, , s] = sign(valid).split('.');
  assert.equal(verifySocketToken(`${h}.${b64({ ...valid, sub: 'someone-else' })}.${s}`, SECRET, now), null);
});

test('rejects expired tokens and the wrong audience', () => {
  assert.equal(verifySocketToken(sign({ ...valid, exp: Math.floor(now / 1000) - 1 }), SECRET, now), null);
  assert.equal(verifySocketToken(sign({ ...valid, aud: 'something-else' }), SECRET, now), null);
});

test('rejects other algorithms, including "none"', () => {
  assert.equal(verifySocketToken(`${b64({ alg: 'none' })}.${b64(valid)}.`, SECRET, now), null);
  assert.equal(verifySocketToken(sign(valid, SECRET, { alg: 'HS512' }), SECRET, now), null);
});

test('rejects missing, malformed and unconfigured input', () => {
  assert.equal(verifySocketToken(undefined, SECRET, now), null);
  assert.equal(verifySocketToken('not-a-token', SECRET, now), null);
  assert.equal(verifySocketToken(sign(valid), undefined, now), null);
});
