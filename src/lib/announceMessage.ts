import { ObjectId } from 'mongodb';

import { offlineMessageManager } from '../offline-messages.js';
import type { MongoDBClient } from '../mongodb.js';
import { withSenders } from './messageSender.js';

/** An announcement may only be announced shortly after the API wrote it. */
const MAX_AGE_MS = 2 * 60_000;

/**
 * Delivers a group notice ("X added Y", "only admins can send messages") that the web API already
 * saved. The API cannot go through `chatMessage`: that event rejects a saved id as a retry, and it
 * never accepts the Announcement type from a client. Here the stored row is the source of truth, so
 * a caller can only replay a fresh notice that it wrote itself, as a group admin.
 */
export async function announceMessage(db: MongoDBClient, userId: string, messageId: unknown): Promise<boolean> {
  if (typeof messageId !== 'string' || !ObjectId.isValid(messageId)) return false;

  const message = await db.chatMessages().findOne({ _id: new ObjectId(messageId) });
  if (!message || message.messageType !== 'Announcement' || message.sender?.id !== userId) return false;
  if (Date.now() - new Date(message.timestamp).getTime() > MAX_AGE_MS) return false;
  if (!ObjectId.isValid(message.chatId)) return false;

  const chat = await db.chats().findOne(
    { _id: new ObjectId(message.chatId) },
    { projection: { chatType: 1, adminIds: 1 } }
  );
  if (!chat || chat.chatType !== 'Group' || !chat.adminIds?.includes(userId)) return false;

  const now = new Date().toISOString();
  await db.chatParticipants().updateMany(
    { chatId: message.chatId },
    { $set: { lastMessageId: messageId, lastUpdated: now } }
  );
  await db.chats().updateOne({ _id: chat._id }, { $set: { lastMessageId: messageId, lastUpdated: now } });

  const participants = await db.chatParticipants().find({ chatId: message.chatId }, { projection: { userId: 1 } }).toArray();
  const memberIds = Array.from(new Set(participants.map((p) => p.userId).filter(Boolean)));
  const [full] = await withSenders(db, [message]);

  await offlineMessageManager.broadcastMessage(
    { type: 'newMessage', data: { ...full, _id: messageId } },
    undefined,
    memberIds
  );
  return true;
}
