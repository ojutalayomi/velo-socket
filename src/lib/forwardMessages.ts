import { ObjectId } from 'mongodb';
import { MongoDBClient } from '../mongodb.js';
import * as S3 from '../s3.js';
import { AttachmentSchema, ChatType, MessageAttributes, MessageType, msgStatus } from '../types.js';
import { canSendMessage } from './chatPermissions.js';
import { chatSocketHandler } from './chatSocketHandler.js';
import { isForwardable, parseForwardRequest } from './forwardRules.js';

const BUCKET = 'files-for-chat';

export type ForwardResult = {
  ok: boolean;
  error?: string;
  results?: { chatId: string; ok: boolean; error?: string }[];
};

/** Key of a stored attachment; prefers the saved key, falls back to the URL path. */
function sourceKey(att: AttachmentSchema): string | null {
  if (att.key) return att.key;
  try {
    return decodeURIComponent(new URL(att.url).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

/** Gives the forwarded message its own copy of every file, so deleting the original keeps it intact. */
async function copyAttachments(attachments: AttachmentSchema[]): Promise<AttachmentSchema[]> {
  const copies: AttachmentSchema[] = [];
  for (const att of attachments) {
    const key = att.url ? sourceKey(att) : null;
    if (!key) continue; // never uploaded, nothing to forward
    const destKey = `${new ObjectId().toHexString()}-${att.name}`;
    try {
      const url = await S3.copyFileInS3(BUCKET, key, destKey);
      copies.push({ ...att, _id: new ObjectId(), key: destKey, url, uploadedAt: new Date().toISOString() });
    } catch (error) {
      console.error('forward: could not copy attachment', error);
    }
  }
  return copies;
}

/**
 * Forwards messages the user can see into chats the user may send to. Identity comes from the
 * socket handshake; every roster and permission is read from the database.
 */
export async function forwardMessages(db: MongoDBClient, userId: string, payload: unknown): Promise<ForwardResult> {
  const request = parseForwardRequest(payload);
  if (!request.ok) return { ok: false, error: request.error };

  // The user must belong to every chat the messages come from.
  const sources = await db
    .chatMessages()
    .find({ _id: { $in: request.messageIds.map((id) => new ObjectId(id)) } })
    .toArray();
  if (sources.length !== request.messageIds.length) return { ok: false, error: 'Some messages no longer exist' };

  const sourceChatIds = Array.from(new Set(sources.map((m) => String(m.chatId))));
  const memberOf = await db
    .chatParticipants()
    .find({ userId, chatId: { $in: sourceChatIds } }, { projection: { chatId: 1 } })
    .toArray();
  if (memberOf.length !== sourceChatIds.length) return { ok: false, error: 'You cannot forward these messages' };

  const forwardable = sources
    .filter((m) => isForwardable({ content: m.content, attachmentCount: m.attachments?.length ?? 0, messageType: m.messageType, viewOnce: Boolean((m as { viewOnce?: boolean }).viewOnce) }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (forwardable.length === 0) return { ok: false, error: 'These messages cannot be forwarded' };

  const user = await db.users().findOne(
    { _id: new ObjectId(userId) },
    { projection: { username: 1, firstname: 1, lastname: 1, displayPicture: 1, verified: 1 } }
  );
  if (!user) return { ok: false, error: 'User not found' };
  const sender = {
    id: userId,
    name: [user.firstname, user.lastname].filter(Boolean).join(' ').trim() || user.username || '',
    displayPicture: user.displayPicture || '',
    username: user.username || '',
    verified: Boolean(user.verified),
  };

  // Messages reference their files by key; the Files collection holds the stored details.
  const attachmentKeys = Array.from(new Set(forwardable.flatMap((m) => (m.attachments ?? []).map(String))));
  const attachmentDocs = attachmentKeys.length
    ? await db.files().find({ key: { $in: attachmentKeys } }).toArray()
    : [];
  const attachmentsByKey = new Map(attachmentDocs.map((doc) => [doc.key, doc]));

  const results: NonNullable<ForwardResult['results']> = [];
  for (const chatId of request.chatIds) {
    const [membership, chat] = await Promise.all([
      db.chatParticipants().findOne({ chatId, userId }, { projection: { _id: 1 } }),
      db.chats().findOne({ _id: new ObjectId(chatId) }, { projection: { chatType: 1, adminIds: 1, onlyAdminsCanSend: 1 } }),
    ]);
    if (!membership || !chat) {
      results.push({ chatId, ok: false, error: 'You are not a member of this chat' });
      continue;
    }
    if (!canSendMessage({
      chatType: chat.chatType,
      onlyAdminsCanSend: chat.onlyAdminsCanSend,
      adminIds: chat.adminIds,
      userId,
    })) {
      results.push({ chatId, ok: false, error: 'Only admins can send messages in this chat' });
      continue;
    }

    let receiverId = chatId;
    if (chat.chatType !== 'Group') {
      const other = await db.chatParticipants().findOne({ chatId, userId: { $ne: userId } }, { projection: { userId: 1 } });
      receiverId = other ? String(other.userId) : userId;
    }

    for (const source of forwardable) {
      const files = (source.attachments ?? [])
        .map((key) => attachmentsByKey.get(String(key)))
        .filter((a): a is AttachmentSchema => Boolean(a));
      const copies = await copyAttachments(files);
      const message: MessageAttributes = {
        _id: new ObjectId().toHexString(),
        chatId,
        receiverId,
        sender,
        content: source.content,
        timestamp: new Date().toISOString(),
        chatType: chat.chatType as ChatType,
        messageType: source.messageType as MessageType,
        reactions: [],
        attachments: [],
        quotedMessageId: '',
        status: 'sent' as msgStatus,
        mentions: [],
      };
      await chatSocketHandler(message, db, userId, { forwarded: true, preparedAttachments: copies });
    }
    results.push({ chatId, ok: true });
  }
  return { ok: results.some((r) => r.ok), results };
}
