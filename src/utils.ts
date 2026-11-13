import { ObjectId } from 'mongodb';
import { io } from './socket.js';
import { MongoDBClient } from './mongodb.js';
import type Redis from 'ioredis';

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
    const lastActive = await redis.get(`user:${userId}:lastActive`);
    io.emit('lastActive', { userId, lastActive });
  }
  io.emit('userStatus', { userId, status });
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

export async function updateReadReceipts(userId: string, redis: Redis) {
  await redis.set(`user:${userId}:readReceipts`, new Date().toISOString());
}

