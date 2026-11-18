import { ObjectId } from 'mongodb';
import type Redis from 'ioredis';

import { MongoDBClient } from '../mongodb.js';
import { filterOnlineUsers } from '../presence.js';
import { deliverPush, messagePreview } from '../push.js';
import type { ChatSettings } from '../types.js';
import { selectRecipients } from './eligibility.js';
import { loadNotificationPreferences } from './settings.js';

export interface ChatNotificationParams {
  db: MongoDBClient;
  redis: Redis;
  chatId: string;
  senderId: string;
  messageId: string;
  content: string;
  attachmentCount: number;
  mentions?: { userId?: string }[];
}

function formatSenderName(user: {
  firstname?: string;
  lastname?: string;
  username?: string;
} | null): string {
  const fullName = [user?.firstname, user?.lastname].filter(Boolean).join(' ').trim();
  return fullName || user?.username || 'Someone';
}

async function loadSenderName(db: MongoDBClient, senderId: string): Promise<string> {
  if (!ObjectId.isValid(senderId)) return 'Someone';

  const user = await db
    .users()
    .findOne(
      { _id: new ObjectId(senderId) },
      { projection: { firstname: 1, lastname: 1, username: 1 } }
    );
  return formatSenderName(user);
}

/** Splits recipients by whether they want message content hidden on the lock screen. */
function splitByPreview(
  recipients: string[],
  preferences: Map<string, { hideMessagePreview: boolean }>
): { visible: string[]; hidden: string[] } {
  const visible: string[] = [];
  const hidden: string[] = [];

  for (const userId of recipients) {
    if (preferences.get(userId)?.hideMessagePreview) hidden.push(userId);
    else visible.push(userId);
  }

  return { visible, hidden };
}

/**
 * Sends mention and message pushes for a new chat message.
 * Persistence, live emits, counters, and offline queues stay in the socket handler.
 */
export async function notifyChatMessage(params: ChatNotificationParams): Promise<void> {
  const { db, redis, chatId, senderId, messageId } = params;
  if (!chatId || !senderId || !ObjectId.isValid(chatId)) return;

  const chat = await db
    .chats()
    .findOne({ _id: new ObjectId(chatId) }, { projection: { chatType: 1 } });
  if (!chat) return;

  const participants = await db.chatParticipants().find({ chatId }).toArray();
  const participantIds = new Set(
    participants.map((participant) => participant.userId).filter(Boolean)
  );
  if (!participantIds.has(senderId)) return;

  const candidateIds = Array.from(participantIds).filter((userId) => userId !== senderId);
  if (candidateIds.length === 0) return;

  const [senderName, preferences, onlineIds, blockedRows] = await Promise.all([
    loadSenderName(db, senderId),
    loadNotificationPreferences(db, candidateIds),
    filterOnlineUsers(redis, candidateIds),
    db
      .blockedUsers()
      .find(
        { blockerId: { $in: candidateIds }, blockedId: senderId },
        { projection: { blockerId: 1, _id: 0 } }
      )
      .toArray(),
  ]);

  const online = new Set(onlineIds);
  const blocked = new Set(blockedRows.map((row) => row.blockerId));
  const muted = new Set(
    participants
      .filter((participant) => (participant.chatSettings as ChatSettings | undefined)?.isMuted)
      .map((participant) => participant.userId)
  );
  const now = new Date();
  const isGroupChat = chat.chatType === 'Group' || chat.chatType === 'Channels';
  const url = isGroupChat ? `/chats/group/${chatId}` : `/chats/${chatId}`;
  const preview = messagePreview(params.content, params.attachmentCount);

  const mentionCandidates = Array.from(
    new Set(
      (params.mentions ?? [])
        .map((mention) => (typeof mention?.userId === 'string' ? mention.userId : ''))
        .filter((userId) => userId && userId !== senderId && participantIds.has(userId))
    )
  );

  const mentionRecipients = mentionCandidates.length
    ? selectRecipients({
        candidates: mentionCandidates,
        senderId,
        kind: 'mention',
        participants: participantIds,
        blocked,
        preferences,
        muted,
        online,
        requireOffline: false,
        now,
      })
    : [];

  if (mentionRecipients.length > 0) {
    const { visible, hidden } = splitByPreview(mentionRecipients, preferences);
    const mentionPayload = {
      title: senderName,
      url,
      tag: `mention:${messageId}`,
    };

    await deliverPush({
      kind: 'mention',
      sourceId: messageId,
      userIds: visible,
      payload: { ...mentionPayload, body: preview },
      requireOffline: false,
      redis,
    });
    await deliverPush({
      kind: 'mention',
      sourceId: messageId,
      userIds: hidden,
      payload: { ...mentionPayload, body: 'You were mentioned' },
      requireOffline: false,
      redis,
    });
  }

  // Channel posts only notify explicitly mentioned members.
  if (chat.chatType === 'Channels') return;

  const mentionSet = new Set(mentionRecipients);
  const messageCandidates = candidateIds.filter((userId) => !mentionSet.has(userId));

  const messageRecipients = messageCandidates.length
    ? selectRecipients({
        candidates: messageCandidates,
        senderId,
        kind: 'message',
        participants: participantIds,
        blocked,
        preferences,
        muted,
        online,
        requireOffline: false,
        now,
      })
    : [];

  if (messageRecipients.length === 0) return;

  const { visible, hidden } = splitByPreview(messageRecipients, preferences);
  const messagePayload = {
    title: senderName,
    url,
    tag: `chat:${chatId}`,
  };

  await deliverPush({
    kind: 'message',
    sourceId: messageId,
    userIds: visible,
    payload: { ...messagePayload, body: preview },
    requireOffline: false,
    redis,
  });
  await deliverPush({
    kind: 'message',
    sourceId: messageId,
    userIds: hidden,
    payload: { ...messagePayload, body: 'New message' },
    requireOffline: false,
    redis,
  });
}
