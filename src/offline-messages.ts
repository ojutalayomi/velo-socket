import type { Redis } from 'ioredis';
import { io } from './socket.js';
import { redis as sharedRedis } from './redis.js';
import {
  filterOfflineUsers as filterOfflinePresence,
  getOnlineUserIds,
  isUserOnline as isPresenceOnline,
} from './presence.js';

export interface OfflineMessage {
  id: string;
  type:
    | 'updatePost'
    | 'newPost'
    | 'newComment'
    | 'deletePost'
    | 'newChat'
    | 'newMessage'
    | 'reactionAdded'
    | 'reactionRemoved'
    | 'reactionUpdated'
    | 'conversationUpdated'
    | 'chatParticipantsUpdated'
    | 'chatDetailsUpdated'
    | 'chatRemoved'
    | 'messageDeleted'
    | 'joinChat'
    | 'followNotification'
    | 'statusCreated'
    | 'statusDeleted'
    | 'pinnedMessagesUpdated'
    | 'viewOnceUpdated'
    | 'mentionNotification';
  userId: string;
  data: any;
  timestamp: number;
  ttl?: number; // Time to live in seconds
}

export class OfflineMessageManager {
  private redis: Redis;
  private readonly MESSAGE_TTL = 24 * 60 * 60; // 24 hours in seconds
  private readonly MAX_MESSAGES_PER_USER = 1000; // Prevent memory bloat

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Store a message for offline users
   */
  async storeMessage(message: Omit<OfflineMessage, 'id' | 'timestamp'>): Promise<void> {
    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fullMessage: OfflineMessage = {
      ...message,
      id: messageId,
      timestamp: Date.now(),
      ttl: message.ttl || this.MESSAGE_TTL
    };

    const key = `offline_messages:${message.userId}`;
    
    // Store the message
    await this.redis.lpush(key, JSON.stringify(fullMessage));
    
    // Set expiration
    await this.redis.expire(key, message.ttl || this.MESSAGE_TTL);
    
    // Trim to max messages to prevent memory bloat
    await this.redis.ltrim(key, 0, this.MAX_MESSAGES_PER_USER - 1);
  }

  /**
   * Get all pending messages for a user
   */
  async getMessagesForUser(userId: string): Promise<OfflineMessage[]> {
    const key = `offline_messages:${userId}`;
    const messages = await this.redis.lrange(key, 0, -1);
    
    return messages.map(msg => JSON.parse(msg)).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Clear messages for a user after they've been delivered
   */
  async clearMessagesForUser(userId: string): Promise<void> {
    const key = `offline_messages:${userId}`;
    await this.redis.del(key);
  }

  /**
   * Check if a user is online
   */
  async isUserOnline(userId: string): Promise<boolean> {
    return isPresenceOnline(this.redis, userId);
  }

  /**
   * Filter a list of user ids down to those without an active socket connection.
   */
  async filterOfflineUsers(userIds: string[]): Promise<string[]> {
    return filterOfflinePresence(this.redis, userIds);
  }

  /**
   * Broadcast message to online users and store for offline users
   */
  async broadcastMessage(
    message: Omit<OfflineMessage, 'id' | 'timestamp' | 'userId'>,
    excludeUserId?: string,
    targetUserIds?: string[]
  ): Promise<void> {
    const onlineUsers = new Set(await getOnlineUserIds(this.redis));

    // If specific target users are provided, use those; otherwise broadcast to all online users
    const usersToNotify = targetUserIds
      ? Array.from(new Set(targetUserIds.filter(Boolean)))
      : Array.from(onlineUsers);

    for (const userId of usersToNotify) {
      const isOnline = onlineUsers.has(userId);

      if (isOnline && userId !== excludeUserId) {
        // Send directly to online users
        io.to(`user:${userId}`).emit(message.type, message.data);
      } else if (!isOnline) {
        // Store for offline users
        await this.storeMessage({
          ...message,
          userId
        });
      }
    }
  }

  /**
   * Handle user coming back online - deliver pending messages
   */
  async handleUserOnline(userId: string): Promise<void> {
    const messages = await this.getMessagesForUser(userId);
    console.log('messages', messages);
    
    if (messages.length > 0) {
      // Send all pending messages
      for (const message of messages) {
        io.to(`user:${userId}`).emit(message.type, message.data);
      }
      
      // Clear the messages after delivery
      await this.clearMessagesForUser(userId);
      
      console.log(`Delivered ${messages.length} offline messages to user ${userId}`);
    }
  }
}

// Export singleton instance - will be initialized in app.ts
export let offlineMessageManager = new OfflineMessageManager(sharedRedis);
