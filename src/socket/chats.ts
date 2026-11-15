import { ObjectId } from "mongodb";
import * as S3 from "../s3.js";
import { AttachmentSchema, ConvoType1, MessageAttributes, MessageType, msgStatus, NewChat_, Reaction, UserSchema } from "../types.js";
import { MongoDBClient } from "../mongodb.js";
import { io, UserSocket } from '../socket.js';
import { offlineMessageManager } from '../offline-messages.js';
import { chatSocketHandler } from "../lib/chatSocketHandler.js";
import { isChatParticipant } from '../utils.js';

io.on('connection', async (socket: UserSocket) => {
  try {
    // console.log('Connected to the socket ctrl');
    const userId = socket.handshake.query.userId as string;

    if (!userId) {
      console.error('No userId provided in socket connection');
      socket.disconnect();
      return;
    }

    let db;
    try {
      db = await new MongoDBClient().init();
    } catch (error) {
      console.error('Failed to initialize database connection:', error);
      io.to(`user:${userId}`).emit('chatError', { error: 'Database connection failed' });
      socket.disconnect();
      return;
    }

    socket.on('leaveChat', (chatId: string) => {
      socket.leave(chatId);
    });

    socket.on('addChat', async (data: NewChat_) => {
      // console.log(data.chat.participants)
      if (data.chat && data.chat.participants && data.chat.participants.length > 0) {
        const participantUserIds = Array.from(new Set(data.chat.participants.map(participant => participant.userId)));

        await offlineMessageManager.broadcastMessage({
          type: 'newChat',
          data
        }, userId, participantUserIds);
      } else {
        console.warn('addChat: No participants found in chat data');
      }
    });

    socket.on('addReaction', async (data: Reaction) => {
      try {
        const message = await db.chatMessages().findOne({ _id: new ObjectId(data.messageId) });
        if (!message) {
          io.to(`user:${data.userId}`).emit('chatError', { error: 'Message not found' });
          return;
        }
        console.log(message);
        // Check if user already reacted
        const existingReaction = await db.chatReactions().findOne({
          messageId: message._id.toString(),
          userId: data.userId
        });

        if (existingReaction) {
          // If same reaction, remove it
          const participants = (await db.chatParticipants().find({ chatId: message.chatId }).toArray()).map(p => p.userId);
          if (existingReaction.reaction === data.reaction) {
            await db.chatReactions().deleteOne({
              messageId: message._id.toString(),
              userId: data.userId
            });
            if (message.chatType === 'Group') {
              await offlineMessageManager.broadcastMessage({ type: 'reactionRemoved', data }, undefined, participants);
            } else {
              const targets = Array.from(new Set([message.sender.id, message.receiverId]));
              await offlineMessageManager.broadcastMessage({ type: 'reactionRemoved', data }, undefined, targets);
            }
          } else {
            // If different reaction, update it
            await db.chatReactions().updateOne(
              {
                messageId: message._id.toString(),
                userId: data.userId
              },
              { $set: { reaction: data.reaction } }
            );
            if (message.chatType === 'Group') {
              await offlineMessageManager.broadcastMessage({ type: 'reactionUpdated', data }, undefined, participants);
            } else {
              const targets = Array.from(new Set([message.sender.id, message.receiverId]));
              await offlineMessageManager.broadcastMessage({ type: 'reactionUpdated', data }, undefined, targets);
            }
          }
        } else {
          // No existing reaction, insert new one
          await db.chatReactions().insertOne({
            ...data,
            messageId: message._id.toString()
          });
          if (message.chatType === 'Group') {
            const participants = (await db.chatParticipants().find({ chatId: message.chatId }).toArray()).map(p => p.userId);
            await offlineMessageManager.broadcastMessage({ type: 'reactionAdded', data }, undefined, participants);
          } else {
            const targets = Array.from(new Set([message.sender.id, message.receiverId]));
            await offlineMessageManager.broadcastMessage({ type: 'reactionAdded', data }, undefined, targets);
          }
        }
      } catch (error) {
        console.error('Error in addReaction:', error);
        io.to(`user:${data.userId}`).emit('chatError', { error: 'Failed to process reaction' });
      }
    });

    socket.on('updateConversation', async (data: {id: string, updates: Partial<ConvoType1>}) => {
      try {
        const { id, updates } = data;
        // console.log(data)

        // Delete message
        if (data.updates.deleted) {
          // Delete chat
          if (data.updates.convo) {
            const chatId = new ObjectId(id);
            const chat = await db.chats().findOne({ _id: chatId });

            if (!chat) {
              // console.log('Chat not found:', id);
              // Emit an error event to the client
              io.to(`user:${userId}`).emit('chatError', {
                error: 'Chat not found',
                chatId: id,
                updates: updates
              });
              return;
            }

            // Proceed with deletion only if chat exists
            const result = await db.chats().deleteOne({ _id: chatId });
            const result1 = await db.chatMessages().deleteMany({ chatId: chatId.toString() });
            const messages = await db.chatMessages().find({ chatId: chatId.toString() }).toArray();
            // console.log(result,result1,messages)

            // Delete attachments from S3 if they exist
            if (messages && messages.length > 0) {
              for (const message of messages) {
                if (message.attachments && message.attachments.length > 0) {
                  try {
                    await S3.deleteFileFromS3('files-for-chat', message.attachments);
                  } catch (error) {
                    console.error('Error deleting attachment from S3:', error);
                  }
                }
              }
            }

            const result2 = await db.chatParticipants().deleteMany({ chatId: chatId.toString() })
            // console.log(result2)
            const result3 = await db.readReceipts().deleteMany({ chatId: chatId.toString() })
            // console.log(result3)
            // console.log(`Deleted ${result.deletedCount + result1.deletedCount} message(s)`); // Log the result of the deletion
            return;
          } else {
            const messageId = new ObjectId(id);
            const message = await db.chatMessages().findOne({ _id: messageId });
            if (message && message.attachments && message.attachments.length > 0) {
              try {
                await S3.deleteFileFromS3('files-for-chat', message.attachments);
              } catch (error) {
                console.error('Error deleting attachment from S3:', error);
              }
            }
            await db.chatMessages().deleteOne({ _id: messageId })
            await db.readReceipts().deleteMany({ messageId: messageId.toString() })
            // console.log(`Deleted ${result.deletedCount} message(s)`); // Log the result of the deletion
            return;
          }
        }

        const updateFields = Object.keys(updates).map((key) => {
          return key;
        });
        const update = {
          $set: updateFields.reduce((acc, field, index) => {
            acc[field] = updates[Object.keys(updates)[index] as keyof typeof updates];
            return acc;
          }, {} as Record<string, any>),
        };

        const result = await db.chatParticipants().updateOne(
          { chatId: id, userId: updates.userId },
          update
        );
        // console.log(`Changed prop is ${result}`)
        io.to(`user:${updates.userId}`).emit('conversationUpdated', { id: id, updates });
      } catch (error) {
        console.error('Error in updateConversation:', error);
        socket.emit('chatError', { error: 'Failed to update conversation' });
      }
    });

    socket.on('chatMessage', async (data: MessageAttributes) => {
      await chatSocketHandler(data, db, userId);
    });

    socket.on('typing', (data: { user: Partial<UserSchema>, to: string }) => {
      try {
        io.to(data.to).emit('userTyping', data);
      } catch (error) {
        console.error('Error in typing event:', error);
      }
    });

    socket.on('stopTyping', (data: { user: Partial<UserSchema>, to: string }) => {
      try {
        io.to(data.to).emit('userStopTyping', data);
      } catch (error) {
        console.error('Error in stopTyping event:', error);
      }
    });

    socket.on('joinChat', async (data: { chatId: string }) => {
      try {
        const { chatId } = data;
        if (!chatId || !ObjectId.isValid(chatId)) return;
        if (!(await isChatParticipant(chatId, userId))) {
          console.warn(`joinChat rejected; ${userId} is not in chat ${chatId}`);
          socket.emit('chatError', { error: 'You are not a member of this chat' });
          return;
        }
        socket.join(`group:${chatId}`);
        io.to(`group:${chatId}`).emit('groupAnnouncement', { chatId, userId: userId });
      } catch (error) {
        console.error('Error in joinChat event:', error);
      }
    });

    // Announced by the API after it inserts membership rows. Re-derive the roster
    // from the DB so a forged payload cannot pull non-members into the room.
    socket.on('chat:participantsAdded', async (data: { chatId: string, addedUserIds?: string[] }, ack?: () => void) => {
      try {
        const chatId = data?.chatId;
        if (!chatId || !ObjectId.isValid(chatId)) {
          ack?.();
          return;
        }

        const chat = await db.chats().findOne({ _id: new ObjectId(chatId) });
        if (!chat || chat.chatType !== 'Group') {
          ack?.();
          return;
        }

        const participants = await db.chatParticipants().find({ chatId }).toArray();
        const memberIds = Array.from(new Set(participants.map(p => p.userId).filter(Boolean)));
        if (memberIds.length === 0) {
          ack?.();
          return;
        }

        const addedIds = Array.from(new Set(data.addedUserIds ?? [])).filter(id => memberIds.includes(id));

        io.in(memberIds.map(id => `user:${id}`)).socketsJoin(`group:${chatId}`);

        const chatPayload = { ...chat, _id: chat._id.toString(), participants };

        // Added members need the whole conversation; requestId must be the recipient.
        for (const addedUserId of addedIds) {
          await offlineMessageManager.broadcastMessage(
            { type: 'newChat', data: { chat: chatPayload, requestId: addedUserId } },
            undefined,
            [addedUserId]
          );
        }

        await offlineMessageManager.broadcastMessage(
          { type: 'chatParticipantsUpdated', data: { chatId, participants, adminIds: chat.adminIds ?? [] } },
          undefined,
          memberIds
        );

        ack?.();
      } catch (error) {
        console.error('Error in chat:participantsAdded event:', error);
        ack?.();
      }
    });

    // Announced by the API after it deletes membership rows. Membership is re-read so a
    // forged payload cannot evict someone who is still in the group.
    socket.on('chat:participantsRemoved', async (data: { chatId: string, removedUserIds?: string[] }, ack?: () => void) => {
      try {
        const chatId = data?.chatId;
        if (!chatId || !ObjectId.isValid(chatId)) {
          ack?.();
          return;
        }

        // The chat is gone when the last member left.
        const chat = await db.chats().findOne({ _id: new ObjectId(chatId) });
        const participants = chat ? await db.chatParticipants().find({ chatId }).toArray() : [];
        const memberIds = Array.from(new Set(participants.map(p => p.userId).filter(Boolean)));
        const removedIds = Array.from(new Set(data.removedUserIds ?? [])).filter(id => !memberIds.includes(id));
        if (removedIds.length === 0) {
          ack?.();
          return;
        }

        io.in(removedIds.map(id => `user:${id}`)).socketsLeave(`group:${chatId}`);

        for (const removedUserId of removedIds) {
          await offlineMessageManager.broadcastMessage(
            { type: 'chatRemoved', data: { chatId } },
            undefined,
            [removedUserId]
          );
        }

        if (chat && memberIds.length > 0) {
          await offlineMessageManager.broadcastMessage(
            { type: 'chatParticipantsUpdated', data: { chatId, participants, adminIds: chat.adminIds ?? [] } },
            undefined,
            memberIds
          );
        }

        ack?.();
      } catch (error) {
        console.error('Error in chat:participantsRemoved event:', error);
        ack?.();
      }
    });
  } catch (error) {
    console.error('Unexpected error in socket connection handler:', error);
    socket.emit('chatError', { error: 'An unexpected error occurred' });
    socket.disconnect();
  }
});
