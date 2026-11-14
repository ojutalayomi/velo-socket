import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDedupeKey,
  buildFollowDedupeKey,
  buildGroupKey,
  buildLikeDedupeKey,
  recordNotification,
  removeNotification,
} from '../inApp.js';
import type { MongoDBClient } from '../../mongodb.js';
import type { InAppNotification, NotificationActor } from '../../types.js';

interface EmittedEvent {
  userId: string;
  event: string;
  payload: any;
}

class FakeNotifications {
  rows: InAppNotification[] = [];

  async updateOne(
    filter: { dedupeKey: string },
    update: { $setOnInsert: InAppNotification }
  ): Promise<{ upsertedCount: number }> {
    if (this.rows.some((row) => row.dedupeKey === filter.dedupeKey)) {
      return { upsertedCount: 0 };
    }
    this.rows.push({ ...update.$setOnInsert });
    return { upsertedCount: 1 };
  }

  async findOneAndDelete(filter: { dedupeKey: string }): Promise<InAppNotification | null> {
    const index = this.rows.findIndex((row) => row.dedupeKey === filter.dedupeKey);
    if (index === -1) return null;
    return this.rows.splice(index, 1)[0];
  }

  async countDocuments(filter: {
    userId: string;
    readAt: null;
    actorId?: { $nin: string[] };
  }): Promise<number> {
    const blocked = filter.actorId?.$nin ?? [];
    return this.rows.filter(
      (row) =>
        row.userId === filter.userId &&
        row.readAt === null &&
        !blocked.includes(row.actorId)
    ).length;
  }
}

function makeDb(blocked: Array<{ blockerId: string; blockedId: string }> = []) {
  const notifications = new FakeNotifications();
  const blockedUsers = {
    find: (filter: { blockerId: string }) => ({
      toArray: async () => blocked.filter((row) => row.blockerId === filter.blockerId),
    }),
    findOne: async (filter: { blockerId: string; blockedId: string }) =>
      blocked.find(
        (row) => row.blockerId === filter.blockerId && row.blockedId === filter.blockedId
      ) ?? null,
  };

  const db = {
    notifications: () => notifications,
    blockedUsers: () => blockedUsers,
  } as unknown as MongoDBClient;

  return { db, notifications };
}

const actor: NotificationActor = {
  id: 'actor-1',
  name: 'Alex Johnson',
  username: 'alex',
  displayPicture: 'alex.png',
  verified: true,
};

const baseInput = {
  recipientId: 'recipient-1',
  actorId: 'actor-1',
  actor,
  type: 'like' as const,
  targetType: 'post' as const,
  targetId: 'post-1',
  url: '/alex/posts/post-1',
};

function collect(): { emit: (userId: string, event: string, payload: any) => void; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  return {
    events,
    emit: (userId, event, payload) => events.push({ userId, event, payload }),
  };
}

test('skips self notifications without writing or emitting', async () => {
  const { db, notifications } = makeDb();
  const { emit, events } = collect();

  const written = await recordNotification(
    db,
    { ...baseInput, recipientId: 'actor-1' },
    emit
  );

  assert.equal(written, false);
  assert.equal(notifications.rows.length, 0);
  assert.equal(events.length, 0);
});

test('skips notifications when the recipient blocked the actor', async () => {
  const { db, notifications } = makeDb([
    { blockerId: 'recipient-1', blockedId: 'actor-1' },
  ]);
  const { emit, events } = collect();

  const written = await recordNotification(db, baseInput, emit);

  assert.equal(written, false);
  assert.equal(notifications.rows.length, 0);
  assert.equal(events.length, 0);
});

test('writes once per dedupe key and emits only on insert', async () => {
  const { db, notifications } = makeDb();
  const { emit, events } = collect();

  assert.equal(await recordNotification(db, baseInput, emit), true);
  assert.equal(await recordNotification(db, baseInput, emit), false);

  assert.equal(notifications.rows.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'notification:new');
  assert.equal(events[0].userId, 'recipient-1');
  assert.equal(events[0].payload.unreadCount, 1);
  assert.equal(events[0].payload.notification.groupKey, 'like:post:post-1');
  assert.equal(events[0].payload.notification.actor.id, 'actor-1');
  assert.equal(events[0].payload.notification.url, '/alex/posts/post-1');
});

test('trims snippets and stores an empty snippet as undefined', async () => {
  const { db, notifications } = makeDb();
  const { emit } = collect();

  await recordNotification(db, { ...baseInput, snippet: `  ${'x'.repeat(200)}  ` }, emit);
  assert.equal(notifications.rows[0].snippet?.length, 120);

  await recordNotification(
    db,
    { ...baseInput, type: 'follow', targetType: 'user', targetId: 'actor-1', snippet: '   ' },
    emit
  );
  assert.equal(notifications.rows[1].snippet, undefined);
});

test('removing an event emits the group key, actor and recalculated count', async () => {
  const { db, notifications } = makeDb();
  const { emit, events } = collect();
  const dedupeKey = buildLikeDedupeKey('post', 'post-1', 'recipient-1', 'actor-1');

  await recordNotification(db, baseInput, emit);
  events.length = 0;

  assert.equal(await removeNotification(db, dedupeKey, emit), true);
  assert.equal(await removeNotification(db, dedupeKey, emit), false);

  assert.equal(notifications.rows.length, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {
    groupKey: 'like:post:post-1',
    actorId: 'actor-1',
    unreadCount: 0,
  });
});

test('unread count excludes blocked actors', async () => {
  const { db, notifications } = makeDb([
    { blockerId: 'recipient-1', blockedId: 'actor-1' },
  ]);
  const { emit, events } = collect();

  notifications.rows.push({
    userId: 'recipient-1',
    actorId: 'actor-1',
    actor,
    type: 'like',
    targetType: 'post',
    targetId: 'post-1',
    groupKey: 'like:post:post-1',
    dedupeKey: 'like:post:post-1:recipient-1:actor-1',
    url: '/alex/posts/post-1',
    createdAt: new Date(),
    readAt: null,
  });

  const otherActor: NotificationActor = { ...actor, id: 'actor-2', username: 'sam' };
  await recordNotification(db, { ...baseInput, actor: otherActor, actorId: 'actor-2' }, emit);

  assert.equal(events[0].payload.unreadCount, 1);
});

test('builds the documented group and dedupe keys', () => {
  assert.equal(buildGroupKey('like', 'post', 'p1'), 'like:post:p1');
  assert.equal(buildGroupKey('mention', 'chat_message', 'm1'), 'mention:chat_message:m1');
  assert.equal(buildLikeDedupeKey('comment', 'c1', 'r1', 'a1'), 'like:comment:c1:r1:a1');
  assert.equal(buildFollowDedupeKey('r1', 'a1'), 'follow:r1:a1');
  assert.equal(
    buildDedupeKey('comment', 'post', 'p1', 'r1', 'a1', 'new-comment'),
    'comment:new-comment'
  );
  assert.equal(
    buildDedupeKey('mention', 'post', 'p1', 'r1', 'a1'),
    'mention:post:p1:r1:a1'
  );
});
