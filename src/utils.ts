import { ObjectId } from 'mongodb';
import { io } from './socket.js';
import { MongoDBClient } from './mongodb.js';
import type Redis from 'ioredis';
import { getPrivacy } from './privacy.js';

export const HEARTBEAT_INTERVAL = 15000; // 15 seconds, safely inside the 30s presence window

export function timeFormatter(){
  const time = new Date().toLocaleString()
  const [datePart, _] = time.split(', ');
  let [month, day, year] = datePart.split('/')
  const formattedDate = year + '/' + month + '/' + day;
  return formattedDate;
}

export function secretKeyy(){
  const secretKey = new ObjectId();
  return secretKey;
}

/**
 * Broadcasts a presence change. The authoritative online state lives in
 * `presence.ts` (Redis ZSET + connection counts); this only informs clients.
 */
export async function updateUserOnlineStatus(
  userId: string,
  isOnline: boolean,
  redis: Redis
) {
  const status = isOnline ? 'online' : 'offline';

  if (!isOnline) {
    // Going offline is the moment they were last seen, whether or not they ever sent an
    // "activity" event (which only fires on mouse/touch). Stamp it, persist it so it survives
    // restarts and is available when the other person opens the chat later, then broadcast it.
    const lastSeen = new Date().toISOString();
    await redis.set(`user:${userId}:lastActive`, lastSeen);
    try {
      const db = await new MongoDBClient().init();
      // Respect the user's "Show last seen" privacy setting: when it is off, don't
      // store or broadcast the time (the web API also hides it for chats).
      const settings = await db.userSettings().findOne({ userId });
      const hidden = (settings as { showLastSeen?: boolean } | null)?.showLastSeen === false;
      if (!hidden) {
        if (ObjectId.isValid(userId)) {
          await db.users().updateOne({ _id: new ObjectId(userId) }, { $set: { lastSeen } });
        }
        io.emit('lastActive', { userId, lastActive: lastSeen });
      }
    } catch (error) {
      console.error('Failed to persist lastSeen:', error);
    }
  }
  // A user who hides their online status always appears offline to everyone else.
  const visible = (await getPrivacy(userId)).showOnlineStatus;
  io.emit('userStatus', { userId, status: isOnline && visible ? 'online' : 'offline' });
}

export async function updateLastActive(userId: string, redis: Redis) {
  await redis.set(`user:${userId}:lastActive`, new Date().toISOString());
}

export const fetchUserGroup = async (userId: string) => {
  const db = await new MongoDBClient().init();
  const participantList = await db.chatParticipants().find({ userId: userId, chatType: 'Group' }).toArray();
  const chatIds = participantList.map(chat => chat.chatId);
  
  return db.chats().find({ _id: { $in: chatIds.map(id => new ObjectId(id)) } }).toArray();
};

/** Membership is the existence of a Chat_Participants row for (chatId, userId). */
export const isChatParticipant = async (chatId: string, userId: string) => {
  if (!chatId || !userId) return false;
  const db = await new MongoDBClient().init();
  const participant = await db.chatParticipants().findOne(
    { chatId, userId },
    { projection: { _id: 1 } }
  );
  return Boolean(participant);
};

export async function updateReadReceipts(userId: string, redis: Redis) {
  await redis.set(`user:${userId}:readReceipts`, new Date().toISOString());
}

