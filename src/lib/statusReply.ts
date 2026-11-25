import { ObjectId } from 'mongodb';

import type { MongoDBClient } from '../mongodb.js';
import type { StatusReplyPreview, StatusSchema } from '../types.js';

/** A snapshot of a status for the card above a reply, so it still reads after the status is gone. */
export function statusReplyPreview(status: Pick<StatusSchema, '_id' | 'userId' | 'mediaType' | 'mediaUrl' | 'text' | 'background' | 'caption' | 'expiresAt'>): StatusReplyPreview {
  const isFile = status.mediaType === 'image' || status.mediaType === 'video';
  return {
    statusId: status._id.toString(),
    ownerId: status.userId,
    mediaType: status.mediaType,
    ...(isFile && status.mediaUrl ? { thumbUrl: status.mediaUrl } : {}),
    ...(status.mediaType === 'text' && status.text ? { text: status.text.slice(0, 200) } : {}),
    ...(status.mediaType === 'text' && status.background ? { background: status.background } : {}),
    ...(status.caption ? { caption: status.caption.slice(0, 120) } : {}),
    expiresAt: status.expiresAt,
  };
}

export interface StatusReplyContext {
  senderId: string;
  ownerId: string;
  chatType: string;
  receiverId: string;
  expiresAt: string;
  now?: Date;
  senderFollowsOwner: boolean;
  ownerBlockedSender: boolean;
}

/**
 * Who may attach a status to a message: a follower of the owner, writing to the owner in a DM,
 * while the status is still up. Anything else is sent as an ordinary message.
 */
export function canReplyToStatus(context: StatusReplyContext): boolean {
  const now = (context.now ?? new Date()).toISOString();
  return (
    context.chatType === 'DM' &&
    context.senderId !== context.ownerId &&
    context.receiverId === context.ownerId &&
    context.expiresAt > now &&
    context.senderFollowsOwner &&
    !context.ownerBlockedSender
  );
}

/**
 * Turns the `statusReply` a client sent into the preview we store, or nothing. Only the status id
 * is read from the client; everything shown comes from the status in the database.
 */
export async function resolveStatusReply(
  db: MongoDBClient,
  senderId: string,
  message: { chatType: string; receiverId: string; statusReply?: { statusId?: unknown } }
): Promise<StatusReplyPreview | undefined> {
  const statusId = String(message.statusReply?.statusId ?? '');
  if (!ObjectId.isValid(statusId)) return undefined;

  const status = await db.statuses().findOne({ _id: new ObjectId(statusId) });
  if (!status) return undefined;

  const [follows, blocked] = await Promise.all([
    db.followers().findOne({ followerId: senderId, followedId: status.userId }, { projection: { _id: 1 } }),
    db.blockedUsers().findOne({ blockerId: status.userId, blockedId: senderId }, { projection: { _id: 1 } }),
  ]);

  return canReplyToStatus({
    senderId,
    ownerId: status.userId,
    chatType: message.chatType,
    receiverId: message.receiverId,
    expiresAt: status.expiresAt,
    senderFollowsOwner: Boolean(follows),
    ownerBlockedSender: Boolean(blocked),
  })
    ? statusReplyPreview(status)
    : undefined;
}
