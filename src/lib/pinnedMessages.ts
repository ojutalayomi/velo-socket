import { ObjectId } from 'mongodb';

import type { MongoDBClient } from '../mongodb.js';
import { offlineMessageManager } from '../offline-messages.js';
import { canPinMessages, planPin, planUnpin, type PinnedMessage } from './pinRules.js';

export type PinResult = { ok: true; pins: PinnedMessage[] } | { ok: false; error: string };

const DELETED_MARKER = '≤≤≤';

/** Tells every member of the chat what is pinned now (queued for those who are offline). */
export async function broadcastPins(db: MongoDBClient, chatId: string, pins: PinnedMessage[]) {
  const members = await db.chatParticipants().find({ chatId }, { projection: { userId: 1 } }).toArray();
  const memberIds = Array.from(new Set(members.map((row) => row.userId).filter(Boolean)));
  if (memberIds.length === 0) return;
  await offlineMessageManager.broadcastMessage(
    { type: 'pinnedMessagesUpdated', data: { chatId, pinnedMessages: pins } },
    undefined,
    memberIds
  );
}

async function loadChat(db: MongoDBClient, chatId: string, userId: string) {
  if (!ObjectId.isValid(chatId)) return { error: 'Invalid chat' as const };
  const member = await db.chatParticipants().findOne({ chatId, userId }, { projection: { _id: 1 } });
  if (!member) return { error: 'You are not a member of this chat' as const };
  const chat = await db.chats().findOne(
    { _id: new ObjectId(chatId) },
    { projection: { chatType: 1, adminIds: 1, pinnedMessages: 1 } }
  );
  if (!chat) return { error: 'Chat not found' as const };
  if (!canPinMessages({ chatType: chat.chatType, adminIds: chat.adminIds, userId })) {
    return { error: 'Only group admins can pin messages' as const };
  }
  return { chat };
}

export async function pinMessage(
  db: MongoDBClient,
  params: { userId: string; chatId: string; messageId: string }
): Promise<PinResult> {
  const { userId, chatId, messageId } = params;
  const loaded = await loadChat(db, chatId, userId);
  if (!loaded.chat) return { ok: false, error: loaded.error ?? 'Chat not found' };

  // Only a real, live message of this chat can be pinned.
  const message = ObjectId.isValid(messageId)
    ? await db.chatMessages().findOne({ _id: new ObjectId(messageId), chatId }, { projection: { content: 1 } })
    : null;
  if (!message) return { ok: false, error: 'Message not found' };
  if (message.content?.endsWith(DELETED_MARKER)) return { ok: false, error: "Deleted messages can't be pinned" };

  const plan = planPin(loaded.chat.pinnedMessages, messageId, userId);
  if (!plan.ok) return plan;
  if (plan.changed) {
    await db.chats().updateOne({ _id: new ObjectId(chatId) }, { $set: { pinnedMessages: plan.pins } });
    await broadcastPins(db, chatId, plan.pins);
  }
  return { ok: true, pins: plan.pins };
}

export async function unpinMessage(
  db: MongoDBClient,
  params: { userId: string; chatId: string; messageId: string }
): Promise<PinResult> {
  const { userId, chatId, messageId } = params;
  const loaded = await loadChat(db, chatId, userId);
  if (!loaded.chat) return { ok: false, error: loaded.error ?? 'Chat not found' };

  const plan = planUnpin(loaded.chat.pinnedMessages, messageId);
  if (plan.changed) {
    await db.chats().updateOne({ _id: new ObjectId(chatId) }, { $set: { pinnedMessages: plan.pins } });
    await broadcastPins(db, chatId, plan.pins);
  }
  return { ok: true, pins: plan.pins };
}

/** A deleted message can't stay pinned. */
export async function removePinsForMessage(db: MongoDBClient, chatId: string, messageId: string) {
  if (!ObjectId.isValid(chatId)) return;
  const chat = await db.chats().findOne({ _id: new ObjectId(chatId) }, { projection: { pinnedMessages: 1 } });
  const plan = planUnpin(chat?.pinnedMessages, messageId);
  if (!plan.changed) return;
  await db.chats().updateOne({ _id: new ObjectId(chatId) }, { $set: { pinnedMessages: plan.pins } });
  await broadcastPins(db, chatId, plan.pins);
}
