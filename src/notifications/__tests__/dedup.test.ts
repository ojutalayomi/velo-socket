import assert from 'node:assert/strict';
import test from 'node:test';
import type Redis from 'ioredis';
import { claimBatch } from '../dedup.js';

class FakeRedis {
  private readonly keys = new Set<string>();

  pipeline() {
    const operations: Array<() => [null, unknown]> = [];

    const pipeline = {
      set: (key: string, _value: string, _ex: string, _ttl: string, _nx: string) => {
        operations.push(() => {
          if (this.keys.has(key)) return [null, null];
          this.keys.add(key);
          return [null, 'OK'];
        });
        return pipeline;
      },
      exec: async () => operations.map((operation) => operation()),
    };

    return pipeline;
  }

  has(key: string) {
    return this.keys.has(key);
  }
}

function asRedis(redis: FakeRedis): Redis {
  return redis as unknown as Redis;
}

test('message dedup drops duplicate claims for the same source', async () => {
  const redis = new FakeRedis();

  assert.deepEqual(
    await claimBatch(asRedis(redis), 'message', ['user-1'], 'message-1'),
    ['user-1']
  );
  assert.deepEqual(
    await claimBatch(asRedis(redis), 'message', ['user-1'], 'message-1'),
    []
  );
  assert.ok(redis.has('push:dedup:message:user-1:message-1'));
});

test('follow dedup is scoped by kind and follower', async () => {
  const redis = new FakeRedis();

  assert.deepEqual(
    await claimBatch(asRedis(redis), 'follow', ['recipient'], 'follower-1'),
    ['recipient']
  );
  assert.deepEqual(
    await claimBatch(asRedis(redis), 'follow', ['recipient'], 'follower-1'),
    []
  );
  // A different follower can still notify the same recipient
  assert.deepEqual(
    await claimBatch(asRedis(redis), 'follow', ['recipient'], 'follower-2'),
    ['recipient']
  );
  // Message and follow kinds do not collide
  assert.deepEqual(
    await claimBatch(asRedis(redis), 'message', ['recipient'], 'follower-1'),
    ['recipient']
  );
});

test('missed and incoming call claims are independent', async () => {
  const redis = new FakeRedis();

  assert.deepEqual(
    await claimBatch(asRedis(redis), 'call-incoming', ['callee'], 'call-1'),
    ['callee']
  );
  assert.deepEqual(
    await claimBatch(asRedis(redis), 'call-missed', ['callee'], 'call-1'),
    ['callee']
  );
});

test('test sends without a source id bypass dedup', async () => {
  const redis = new FakeRedis();

  assert.deepEqual(await claimBatch(asRedis(redis), 'message', ['user-1']), ['user-1']);
  assert.deepEqual(await claimBatch(asRedis(redis), 'message', ['user-1']), ['user-1']);
});

test('returns only the recipients that won the claim', async () => {
  const redis = new FakeRedis();
  await claimBatch(asRedis(redis), 'message', ['user-1'], 'message-1');

  assert.deepEqual(
    await claimBatch(asRedis(redis), 'message', ['user-1', 'user-2'], 'message-1'),
    ['user-2']
  );
});
