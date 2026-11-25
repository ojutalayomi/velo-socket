import { ObjectId } from 'mongodb';

import { MongoDBClient } from '../mongodb.js';
import { offlineMessageManager } from '../offline-messages.js';
import * as S3 from '../s3.js';
import { everyoneOpened, openViewOnceError, viewOnceDeleteAt, viewOnceLinkSeconds } from './viewOnceRules.js';

const BUCKET = 'files-for-chat';

type ViewOnceDoc = {
  _id: ObjectId;
  chatId: string;
  viewOnce?: boolean;
  messageType?: string;
  viewOnceGone?: boolean;
  viewOnceOpens?: Record<string, string>;
  viewOnceDeleteAfter?: string;
  attachments?: string[];
  sender?: { id: string };
  timestamp: string;
};

/** What every member's screen needs to redraw the bubble. Never contains the file. */
async function broadcastState(db: MongoDBClient, doc: ViewOnceDoc, opens: Record<string, string>, gone: boolean) {
  const members = await db.chatParticipants().find({ chatId: doc.chatId }, { projection: { userId: 1 } }).toArray();
  await offlineMessageManager.broadcastMessage(
    {
      type: 'viewOnceUpdated',
      data: {
        chatId: doc.chatId,
        messageId: doc._id.toString(),
        viewOnceOpenedBy: Object.keys(opens),
        viewOnceGone: gone,
      },
    },
    undefined,
    members.map((m) => m.userId)
  );
}

export type OpenViewOnceResult = { ok: true; url: string; expiresInSeconds: number } | { ok: false; error: string };

/**
 * Lets one recipient open a view once message, once. The open is recorded atomically before any
 * link is given out, so two quick taps (or two devices) can never both get the file.
 */
export async function openViewOnce(db: MongoDBClient, params: { userId: string; messageId: string }): Promise<OpenViewOnceResult> {
  const { userId, messageId } = params;
  if (!ObjectId.isValid(messageId)) return { ok: false, error: 'Message not found' };
  const id = new ObjectId(messageId);

  const doc = (await db.chatMessages().findOne({ _id: id })) as unknown as ViewOnceDoc | null;
  if (!doc) return { ok: false, error: 'Message not found' };

  const [membership, members] = await Promise.all([
    db.chatParticipants().findOne({ chatId: doc.chatId, userId }, { projection: { _id: 1 } }),
    db.chatParticipants().find({ chatId: doc.chatId }, { projection: { userId: 1 } }).toArray(),
  ]);
  const fileKey = doc.attachments?.[0];
  const blocked = openViewOnceError({
    viewOnce: doc.viewOnce,
    gone: doc.viewOnceGone,
    senderId: doc.sender?.id ?? '',
    userId,
    isMember: Boolean(membership),
    opens: doc.viewOnceOpens,
    hasFile: Boolean(fileKey),
  });
  if (blocked) return { ok: false, error: blocked };

  const file = await db.files().findOne({ key: String(fileKey) });
  if (!file) return { ok: false, error: 'This is no longer available' };

  // Only one request per person can flip this from "not opened" to "opened".
  const now = new Date();
  const opensPath = `viewOnceOpens.${userId}`;
  const updated = await db.chatMessages().findOneAndUpdate(
    { _id: id, viewOnce: true, viewOnceGone: { $ne: true }, [opensPath]: { $exists: false } } as never,
    { $set: { [opensPath]: now.toISOString(), updatedAt: now.toISOString() } } as never,
    { returnDocument: 'after' }
  );
  const after = updated as unknown as ViewOnceDoc | null;
  if (!after) return { ok: false, error: 'You have already opened this' };

  const opens = after.viewOnceOpens ?? {};
  if (everyoneOpened({ memberIds: members.map((m) => m.userId), senderId: doc.sender?.id ?? '', opens })) {
    const deleteAt = viewOnceDeleteAt({ sentAt: doc.timestamp, allOpenedAt: now }).toISOString();
    await db.chatMessages().updateOne({ _id: id }, { $set: { viewOnceDeleteAfter: deleteAt } } as never);
  }

  const seconds = viewOnceLinkSeconds(doc.messageType);
  let url: string;
  try {
    url = await S3.presignGetUrl(BUCKET, file.key, seconds);
  } catch (error) {
    console.error('view once: could not make a link', error);
    return { ok: false, error: 'Could not open this right now' };
  }

  await broadcastState(db, after, opens, false).catch((error) => console.error('view once: broadcast failed', error));
  return { ok: true, url, expiresInSeconds: seconds };
}

/** Deletes the file behind a view once message and leaves a bubble that says it's gone. */
export async function consumeViewOnce(db: MongoDBClient, doc: ViewOnceDoc) {
  const keys = (doc.attachments ?? []).map(String);
  if (keys.length > 0) {
    try {
      await S3.deleteFileFromS3(BUCKET, keys);
    } catch (error) {
      console.error('view once: could not delete from storage', error);
      return; // try again on the next sweep rather than orphaning the file
    }
    await db.files().deleteMany({ key: { $in: keys } });
  }
  const now = new Date().toISOString();
  await db.chatMessages().updateOne(
    { _id: doc._id },
    { $set: { attachments: [], viewOnceGone: true, updatedAt: now } } as never
  );
  await broadcastState(db, doc, doc.viewOnceOpens ?? {}, true).catch((error) =>
    console.error('view once: broadcast failed', error)
  );
}

/** Deletes every view once file that has been opened by everyone, or has sat unopened for 24 hours. */
export async function sweepViewOnce(db: MongoDBClient, now = new Date()) {
  const due = (await db
    .chatMessages()
    .find({ viewOnce: true, viewOnceGone: { $ne: true }, viewOnceDeleteAfter: { $lte: now.toISOString() } } as never)
    .limit(100)
    .toArray()) as unknown as ViewOnceDoc[];
  for (const doc of due) await consumeViewOnce(db, doc);
  return due.length;
}

/** Runs the sweep every minute. */
export function startViewOnceSweep(getDb: () => Promise<MongoDBClient>) {
  const timer = setInterval(() => {
    getDb()
      .then((db) => sweepViewOnce(db))
      .catch((error) => console.error('view once sweep failed:', error));
  }, 60_000);
  timer.unref?.();
  return timer;
}
