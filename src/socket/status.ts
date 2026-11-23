import { io } from '../socket.js';
import { offlineMessageManager } from '../offline-messages.js';
import { MongoDBClient } from '../mongodb.js';
import { ObjectId } from 'mongodb';

type StatusCreatePayload = {
  group: unknown;
  targetUserIds?: string[];
};

type StatusDeletePayload = {
  statusId: string;
  ownerId: string;
  targetUserIds?: string[];
};

type StatusViewPayload = {
  statusId: string;
  ownerId: string;
  viewerId: string;
  viewedAt: string;
};

io.on('connection', async (socket) => {
  // These events only fan out what the web app has already saved. Each one is checked against the
  // database and tied to the connected user, so a client cannot show anyone a made-up status,
  // delete another person's, or appear as someone who viewed it.
  const userId = socket.handshake.query.userId as string;

  socket.on('status:create', async (data: StatusCreatePayload, ack?: () => void) => {
    try {
      const group = data?.group as { user?: { _id?: string }; statuses?: { _id?: string }[] } | undefined;
      const ids = (group?.statuses ?? []).map((status) => String(status?._id ?? ''));
      if (group?.user?._id === userId && ids.length > 0 && ids.every((id) => ObjectId.isValid(id))) {
        const db = await new MongoDBClient().init();
        const owned = await db.statuses().countDocuments({
          _id: { $in: ids.map((id) => new ObjectId(id)) },
          userId,
        });
        if (owned === ids.length) {
          // Followers (and the owner's other devices) only.
          const followers = new Set(
            (await db.followers().find({ followedId: userId }, { projection: { followerId: 1 } }).toArray()).map(
              (row) => String(row.followerId)
            )
          );
          followers.add(userId);
          const targetUserIds = Array.from(new Set((data.targetUserIds ?? []).filter((id) => followers.has(id))));
          await offlineMessageManager.broadcastMessage(
            {
              type: 'statusCreated',
              data: { group: data.group },
              ttl: 24 * 60 * 60,
            },
            undefined,
            targetUserIds
          );
        }
      }
      ack?.();
    } catch (error) {
      console.error('Error handling status:create event:', error);
      ack?.();
    }
  });

  socket.on('status:delete', async (data: StatusDeletePayload, ack?: () => void) => {
    try {
      const statusId = String(data?.statusId ?? '');
      if (ObjectId.isValid(statusId)) {
        const db = await new MongoDBClient().init();
        // It is already deleted by the time this arrives; if it still exists it is not being deleted.
        const stillThere = await db.statuses().findOne({ _id: new ObjectId(statusId) }, { projection: { _id: 1 } });
        if (!stillThere) {
          const followers = new Set(
            (await db.followers().find({ followedId: userId }, { projection: { followerId: 1 } }).toArray()).map(
              (row) => String(row.followerId)
            )
          );
          followers.add(userId);
          const targetUserIds = Array.from(new Set((data.targetUserIds ?? []).filter((id) => followers.has(id))));
          await offlineMessageManager.broadcastMessage(
            {
              type: 'statusDeleted',
              // Always the connected user: it can only remove its own statuses from other screens.
              data: { statusId, ownerId: userId },
              ttl: 24 * 60 * 60,
            },
            undefined,
            targetUserIds
          );
        }
      }
      ack?.();
    } catch (error) {
      console.error('Error handling status:delete event:', error);
      ack?.();
    }
  });

  socket.on('status:view', async (data: StatusViewPayload, ack?: () => void) => {
    try {
      const statusId = String(data?.statusId ?? '');
      if (ObjectId.isValid(statusId)) {
        // The view the web app recorded for the connected user, nothing the client wrote.
        const db = await new MongoDBClient().init();
        const view = await db.statusViewers().findOne({ statusId, viewerId: userId });
        if (view) {
          // Owner sees the new viewer; the viewer's other devices clear the unviewed ring.
          io.to(`user:${view.ownerId}`).to(`user:${userId}`).emit('statusViewed', {
            statusId,
            ownerId: view.ownerId,
            viewerId: userId,
            viewedAt: view.viewedAt,
          });
        }
      }
      ack?.();
    } catch (error) {
      console.error('Error handling status:view event:', error);
      ack?.();
    }
  });
});
