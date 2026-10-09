import { Router } from 'express';
import type { RequestHandler } from 'express';
import OpenAI from 'openai';
import { MessageAttributes, UserSchema } from '../types.js';
import { ChatMessage } from '../lib/ChatMessage.js';
import { chatSocketHandler } from '../lib/chatSocketHandler.js';
import { MongoDBClient } from '../mongodb.js';
import { io } from '../socket.js';
import { ObjectId } from 'mongodb';
import { SocialMediaUser } from '../lib/User.js';

const router = Router();

const openRouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
    ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
  },
});

const toOpenRouterMessage = (message: MessageAttributes, humanUserId: string) => {
  const role = message.sender.id === humanUserId ? 'user' : 'assistant';
  const firstAttachment = Array.isArray(message.attachments) && message.attachments.length > 0
    ? message.attachments[0]
    : null;

  if (!firstAttachment?.url || !firstAttachment.type?.startsWith('image/')) {
    return {
      role,
      content: message.content,
    };
  }

  return {
    role,
    content: [
      { type: 'text', text: message.content },
      { type: 'image_url', image_url: { url: firstAttachment.url } },
    ],
  };
};

const chatHandler: RequestHandler = async (req, res) => {
  let bot: SocialMediaUser | null = null;
  try {
    if (!req.body.messages[req.body.messages.length - 1].receiverId) {
      console.error("Receiver ID is missing in the last message.");
      res.status(400).json({ error: "Receiver ID is missing in the last message." });
      return;
    }

    const db = await new MongoDBClient().init();

    bot = new SocialMediaUser(
      await db.users().findOne({ _id: new ObjectId(req.body.messages[req.body.messages.length - 1].receiverId) }) as UserSchema
    );

    if (bot.isUserNull()) {
      console.error("Bot user not found.");
      res.status(400).json({ error: "Bot user not found." });
      return;
    }

    io.to(bot._id.toString()).emit('userTyping', { data: bot?.getClientSafeData(), to: bot?._id.toString() });
    const messages = req.body.messages as MessageAttributes[];

    const lastUserMessage = messages[messages.length - 1];
    const result = await openRouter.chat.completions.create({
        model: process.env.OPENROUTER_MODEL || process.env.GEMINI_MODEL || 'openai/gpt-4o-mini',
        messages: messages.map((message) => toOpenRouterMessage(message, lastUserMessage.sender.id)) as any,
        max_tokens: 5000,
        stop: [
          'porn',
          'Pornography',
          'NSFW',
          'OnlyFans',
          'explicit'
        ],
    });

    const botResponse = await ChatMessage.fromOpenRouterResponse(
      result, 
      lastUserMessage.chatId, 
      lastUserMessage.sender.id, 
      lastUserMessage.receiverId, 
      "Markdown", 
      lastUserMessage.chatType
    );
    
    if (!botResponse) {
      console.error("Failed to create bot response.");
      res.status(500).json({ error: "Failed to create bot response." });
      return;
    }

    io.to(lastUserMessage.receiverId).emit('userStopTyping', { data: bot?.getClientSafeData(), to: bot?._id.toString() });

    void chatSocketHandler(lastUserMessage, db).catch(err => console.error("Error handling user message in chatSocketHandler:", err));
    void chatSocketHandler(botResponse.toMessageAttributes(), db).catch(err => console.error("Error handling bot response in chatSocketHandler:", err));
    res.json({ result: botResponse.toMessageAttributes(), reply: botResponse.content });
    return;
  } catch (error) {
    console.error('Error communicating with OpenRouter API:', error);
    io.to(req.body.messages[req.body.messages.length - 1].receiverId).emit('userStopTyping', { data: bot?.getClientSafeData(), to: bot?._id.toString() || "" });
    res.status(500).json(
      { error: "Failed to get a response from the chatbot." },
    );
    return;
  }
}

router.post('/', chatHandler);

export default router;