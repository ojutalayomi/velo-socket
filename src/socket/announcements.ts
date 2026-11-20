import { ObjectId } from 'mongodb';
import { io, UserSocket } from '../socket.js';
import { getMongoDb } from '../mongodb.js';

type AnnouncementPayload = { id?: string };

async function isAdmin(userId: string | undefined): Promise<boolean> {
  if (!userId || !ObjectId.isValid(userId)) return false;
  const db = await getMongoDb();
  const user = await db
    .collection('Users')
    .findOne({ _id: new ObjectId(userId) }, { projection: { role: 1, suspended: 1 } });
  return user?.role === 'admin' && !user.suspended;
}

io.on('connection', (socket: UserSocket) => {
  // Only the id is accepted from the client; content and state always come from the DB.
  socket.on('announcement:publish', async (data: AnnouncementPayload, ack?: () => void) => {
    try {
      const id = data?.id;
      if (typeof id !== 'string' || !ObjectId.isValid(id)) return;
      if (!(await isAdmin(socket.handshake.query.userId as string))) return;

      const db = await getMongoDb();
      const item = await db.collection('Announcements').findOne({ _id: new ObjectId(id) });
      if (!item || !item.active) return;
      if (item.expiresAt && new Date(item.expiresAt) <= new Date()) return;

      io.emit('announcement:new', {
        id: String(item._id),
        title: item.title,
        message: item.message,
        url: item.url ?? null,
      });
    } catch (error) {
      console.error('announcement:publish failed:', error);
    } finally {
      ack?.();
    }
  });

  socket.on('announcement:retire', async (data: AnnouncementPayload, ack?: () => void) => {
    try {
      const id = data?.id;
      if (typeof id !== 'string' || !ObjectId.isValid(id)) return;
      if (!(await isAdmin(socket.handshake.query.userId as string))) return;

      const db = await getMongoDb();
      const item = await db.collection('Announcements').findOne({ _id: new ObjectId(id) });
      if (!item || item.active) return;

      io.emit('announcement:removed', { id });
    } catch (error) {
      console.error('announcement:retire failed:', error);
    } finally {
      ack?.();
    }
  });
});
