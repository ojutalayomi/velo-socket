import { ObjectId } from 'mongodb';
import type Redis from 'ioredis';

import { MongoDBClient } from '../mongodb.js';
import { io } from '../socket.js';
import type { MessageAttributes } from '../types.js';
import { ChatMessage } from './ChatMessage.js';
import { buildAiContext } from './aiContext.js';
import { aiModel, openRouter } from './openRouter.js';

const CONTEXT_MESSAGES = 20;
const MAX_REPLY_TOKENS = 1000;
/** One request per user per chat in this window, so a group cannot run up the model bill. */
const COOLDOWN_SECONDS = 8;

const SYSTEM_PROMPT =
  'You are Velo AI, an assistant inside a group chat on Velo. Several people talk in this chat and ' +
  'each of their messages starts with their name. Answer the person who most recently mentioned ' +
  '@ai, using the earlier messages as context. Be concise, use Markdown only when it helps, and ' +
  'do not start your reply with your own name.';

export interface GroupAiParams {
  db: MongoDBClient;
  redis: Redis;
  chatId: string;
  /** The saved message that mentioned @ai. */
  trigger: MessageAttributes;
  /** Persists and broadcasts the bot's reply (the bot is not a member of the group). */
  deliver: (reply: MessageAttributes, botId: string) => Promise<void>;
}

/** Replies to an `@ai` mention in a group, posting as the configured bot account. */
export async function replyAsAi(params: GroupAiParams): Promise<void> {
  const { db, redis, chatId, trigger, deliver } = params;
  const botId = process.env.AI_BOT_USER_ID;
  if (!botId || !ObjectId.isValid(botId)) {
    console.warn('[ai] AI_BOT_USER_ID is not set to a valid user id; ignoring @ai');
    return;
  }

  const askerId = trigger.sender.id;
  if (askerId === botId) return;

  const claimed = await redis.set(`ai:cooldown:${chatId}:${askerId}`, '1', 'EX', COOLDOWN_SECONDS, 'NX');
  if (!claimed) {
    io.to(`user:${askerId}`).emit('chatError', { error: 'Velo AI is still replying. Try again in a few seconds.' });
    return;
  }

  const bot = await db.users().findOne({ _id: new ObjectId(botId) });
  if (!bot) {
    console.error(`[ai] Bot user ${botId} not found`);
    return;
  }

  const room = `group:${chatId}`;
  const typingUser = { _id: botId, name: bot.name, username: bot.username, displayPicture: bot.displayPicture ?? '' };
  io.to(room).emit('userTyping', { user: typingUser, to: room, chatId });

  try {
    const history = await db
      .chatMessages()
      .find({ chatId })
      .sort({ timestamp: -1 })
      .limit(CONTEXT_MESSAGES)
      .toArray();

    const result = await openRouter.chat.completions.create({
      model: aiModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...buildAiContext(history.reverse(), botId),
      ],
      max_tokens: MAX_REPLY_TOKENS,
    });

    const reply = await ChatMessage.fromOpenRouterResponse(result, chatId, askerId, botId, 'Markdown', 'Group');
    if (!reply) throw new Error('Empty AI response');

    // Group messages are addressed to the chat, and the reply threads under the question.
    reply.receiverId = chatId;
    reply.quotedMessageId = trigger._id ?? '';
    await deliver(reply.toMessageAttributes(), botId);
  } catch (error) {
    console.error('[ai] Failed to reply in group:', error);
    io.to(`user:${askerId}`).emit('chatError', { error: 'Velo AI could not reply right now.' });
  } finally {
    io.to(room).emit('userStopTyping', { user: typingUser, to: room, chatId });
  }
}
