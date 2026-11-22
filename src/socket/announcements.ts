import { ObjectId } from 'mongodb';
import { io } from '../socket.js';
import { getMongoDb } from '../mongodb.js';

/**
 * Pushes a live announcement to every connected client. Content and state always come from the
 * database; callers only supply the id. Returns false when there was nothing valid to broadcast.
 */
export async function broadcastAnnouncement(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getMongoDb();
  const item = await db.collection('Announcements').findOne({ _id: new ObjectId(id) });
  if (!item || !item.active) return false;
  if (item.expiresAt && new Date(item.expiresAt) <= new Date()) return false;

  io.emit('announcement:new', {
    id: String(item._id),
    title: item.title,
    message: item.message,
    url: item.url ?? null,
  });
  return true;
}

/** Tells every client to drop a retired announcement. Only valid for inactive announcements. */
export async function broadcastRetirement(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getMongoDb();
  const item = await db.collection('Announcements').findOne({ _id: new ObjectId(id) });
  if (!item || item.active) return false;

  io.emit('announcement:removed', { id });
  return true;
}
