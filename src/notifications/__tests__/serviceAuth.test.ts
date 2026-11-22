import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { isServiceRequest, requestUserId, secretMatches } from '../../lib/serviceAuth.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(sub: string, secret: string) {
  const body = `${b64({ alg: 'HS256' })}.${b64({ sub, aud: 'velo-socket', exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const req = (authorization?: string) => ({ headers: { authorization } });

afterEach(() => {
  delete process.env.SOCKET_BROADCAST_SECRET;
  delete process.env.SOCKET_AUTH_SECRET;
});

test('secretMatches needs a configured, identical secret', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abd', 'abc'), false);
  assert.equal(secretMatches('abc', undefined), false);
  assert.equal(secretMatches('', ''), false);
});

test('a service request presents the broadcast secret as a Bearer token', () => {
  process.env.SOCKET_BROADCAST_SECRET = 'svc';
  assert.equal(isServiceRequest(req('Bearer svc')), true);
  assert.equal(isServiceRequest(req('Bearer nope')), false);
  assert.equal(isServiceRequest(req('svc')), false);
  assert.equal(isServiceRequest(req(undefined)), false);
});

test('without a configured secret nothing counts as a service request', () => {
  assert.equal(isServiceRequest(req('Bearer ')), false);
});

test('requestUserId reads the signed-in user from a valid token only', () => {
  process.env.SOCKET_AUTH_SECRET = 'auth';
  assert.equal(requestUserId(req(`Bearer ${token('u1', 'auth')}`)), 'u1');
  assert.equal(requestUserId(req(`Bearer ${token('u1', 'wrong')}`)), null);
  assert.equal(requestUserId(req(undefined)), null);
});

test('a user token is not a service credential', () => {
  process.env.SOCKET_AUTH_SECRET = 'auth';
  process.env.SOCKET_BROADCAST_SECRET = 'svc';
  assert.equal(isServiceRequest(req(`Bearer ${token('u1', 'auth')}`)), false);
});
