import { ObjectId } from 'mongodb';
import { MongoDBClient } from '../mongodb.js';
import type {
  InAppNotification,
  NotificationActor,
  NotificationTarget,
  NotificationType,
  UserSchema,
} from '../types.js';

export const NOTIFICATIONS_TTL_SECONDS = 180 * 24 * 60 * 60;
const SNIPPET_MAX_LENGTH = 120;

export type NotificationEmitter = (
  userId: string,
  event: 'notification:new' | 'notification:removed',
  payload: unknown
) => void;

// Loaded lazily so importing the write layer (e.g. in unit tests) never opens a
// socket connection at module evaluation time.
const defaultEmitter: NotificationEmitter = (userId, event, payload) => {
  void import('../socket.js').then(({ io }) => {
    io.to(`user:${userId}`).emit(event, payload);
  });
};

export interface RecordNotificationInput {
  recipientId: string;
  actorId: string;
  actor?: NotificationActor;
  type: NotificationType;
  targetType: NotificationTarget;
  targetId: string;
  /** Unique id of the event when it differs from the group target (e.g. a new comment). */
  sourceId?: string;
  url: string;
  snippet?: string;
  chatId?: string;
  chatType?: string;
  createdAt?: Date;
}

export function buildGroupKey(
  type: NotificationType,
  targetType: NotificationTarget,
  targetId: string
): string {
  return `${type}:${targetType}:${targetId}`;
}

export function buildDedupeKey(
  type: NotificationType,
  targetType: NotificationTarget,
  targetId: string,
  recipientId: string,
  actorId: string,
  sourceId?: string
): string {
  if (type === 'comment') return `comment:${sourceId ?? targetId}`;
  if (type === 'follow') return `follow:${recipientId}:${actorId}`;
  return `${type}:${targetType}:${targetId}:${recipientId}:${actorId}`;
}

export function buildLikeDedupeKey(
  targetType: NotificationTarget,
  targetId: string,
  recipientId: string,
  actorId: string
): string {
  return buildDedupeKey('like', targetType, targetId, recipientId, actorId);
}

export function buildFollowDedupeKey(recipientId: string, actorId: string): string {
  return buildDedupeKey('follow', 'user', actorId, recipientId, actorId);
}

export function actorFromUser(user: UserSchema | null, userId: string): NotificationActor | null {
  if (!user) return null;

  const name =
    [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
    user.username ||
    'Someone';

  return {
    id: userId,
    name,
    username: user.username || '',
    displayPicture: user.displayPicture || '',
    verified: Boolean(user.verified),
  };
}

export async function loadActor(
  db: MongoDBClient,
  actorId: string
): Promise<NotificationActor | null> {
  if (!ObjectId.isValid(actorId)) return null;

  const user = await db.users().findOne(
    { _id: new ObjectId(actorId) },
    {
      projection: {
        username: 1,
        firstname: 1,
        lastname: 1,
        displayPicture: 1,
        verified: 1,
      },
    }
  );

  return actorFromUser(user, actorId);
}

async function getBlockedActorIds(db: MongoDBClient, userId: string): Promise<string[]> {
  const rows = await db
    .blockedUsers()
    .find({ blockerId: userId }, { projection: { _id: 0, blockedId: 1 } })
    .toArray();

  return rows.map((row) => row.blockedId).filter(Boolean);
}

export async function getUnreadCount(db: MongoDBClient, userId: string): Promise<number> {
  const blockedIds = await getBlockedActorIds(db, userId);
  const filter: Record<string, unknown> = { userId, readAt: null };
  if (blockedIds.length > 0) filter.actorId = { $nin: blockedIds };

  return db.notifications().countDocuments(filter);
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: number }).code === 11000
  );
}

export async function recordNotification(
  db: MongoDBClient,
  input: RecordNotificationInput,
  emit: NotificationEmitter = defaultEmitter
): Promise<boolean> {
  const { recipientId, actorId } = input;

  if (!recipientId || !actorId || recipientId === actorId) return false;

  const actor = input.actor ?? (await loadActor(db, actorId));
  if (!actor) return false;

  const blocked = await db.blockedUsers().findOne({ blockerId: recipientId, blockedId: actorId });
  if (blocked) return false;

  const sourceId = input.sourceId ?? input.targetId;
  const groupKey = buildGroupKey(input.type, input.targetType, input.targetId);
  const dedupeKey = buildDedupeKey(
    input.type,
    input.targetType,
    input.targetId,
    recipientId,
    actorId,
    sourceId
  );

  const snippet = input.snippet?.trim().slice(0, SNIPPET_MAX_LENGTH) || undefined;
  const createdAt = input.createdAt ?? new Date();

  const notification: InAppNotification = {
    userId: recipientId,
    actorId,
    actor,
    type: input.type,
    targetType: input.targetType,
    targetId: input.targetId,
    groupKey,
    dedupeKey,
    url: input.url,
    snippet,
    chatId: input.chatId,
    chatType: input.chatType,
    createdAt,
    readAt: null,
  };

  try {
    const result = await db
      .notifications()
      .updateOne({ dedupeKey }, { $setOnInsert: notification }, { upsert: true });

    if (!result.upsertedCount) return false;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }

  const unreadCount = await getUnreadCount(db, recipientId);

  emit(recipientId, 'notification:new', {
    notification: {
      groupKey,
      type: input.type,
      targetType: input.targetType,
      targetId: input.targetId,
      url: input.url,
      snippet,
      createdAt: createdAt.toISOString(),
      actor,
    },
    unreadCount,
  });

  return true;
}

export async function removeNotification(
  db: MongoDBClient,
  dedupeKey: string,
  emit: NotificationEmitter = defaultEmitter
): Promise<boolean> {
  const removed = await db.notifications().findOneAndDelete({ dedupeKey });
  if (!removed) return false;

  const unreadCount = await getUnreadCount(db, removed.userId);

  emit(removed.userId, 'notification:removed', {
    groupKey: removed.groupKey,
    actorId: removed.actorId,
    unreadCount,
  });

  return true;
}

export async function ensureInAppIndexes(db: MongoDBClient): Promise<void> {
  await Promise.all([
    db.notifications().createIndex({ userId: 1, createdAt: -1 }),
    db.notifications().createIndex({ userId: 1, readAt: 1 }),
    db.notifications().createIndex({ dedupeKey: 1 }, { unique: true }),
    db.notifications().createIndex({ userId: 1, 'actor.verified': 1, createdAt: -1 }),
    db.notifications().createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: NOTIFICATIONS_TTL_SECONDS }
    ),
  ]);
}
