import { ObjectId } from "mongodb";
import * as S3 from "../s3.js";
import { AttachmentSchema, ConvoType1, MessageAttributes, MessageType, msgStatus, NewChat_, Reaction, UserSchema } from "../types.js";
import { MongoDBClient } from "../mongodb.js";
import { io, UserSocket } from '../socket.js';
import { offlineMessageManager } from '../offline-messages.js';
import { chatSocketHandler } from "../lib/chatSocketHandler.js";
import { forwardMessages } from "../lib/forwardMessages.js";
import { isChatParticipant } from '../utils.js';
import { getPrivacy } from '../privacy.js';
import { ADMIN_DELETED_CONTENT, canDeleteChat, messageDeletion, parseParticipantUpdates, SENDER_DELETED_CONTENT } from '../lib/conversationUpdates.js';

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

    // Announced by the API after it creates a chat. Everything is re-read from the DB so a
    // forged payload cannot push a made-up conversation to other users, and each recipient
    // receives the chat from their own point of view (DM name and picture are the sender's).
    socket.on('addChat', async (data: Pick<NewChat_, 'chat'>, ack?: () => void) => {
      try {
        const chatId = data?.chat?._id?.toString();
        if (!chatId || !ObjectId.isValid(chatId)) {
          ack?.();
          return;
        }

        const chat = await db.chats().findOne({ _id: new ObjectId(chatId) });
        if (!chat) {
          ack?.();
          return;
        }

        const participants = await db.chatParticipants().find({ chatId }).toArray();
        if (!participants.some(participant => participant.userId === userId)) {
          console.warn(`addChat rejected; ${userId} is not in chat ${chatId}`);
          ack?.();
          return;
        }

        const memberIds = Array.from(new Set(participants.map(participant => participant.userId).filter(Boolean)));
        const recipientIds = memberIds.filter(id => id !== userId);

        let sender: Pick<UserSchema, 'name' | 'displayPicture'> | null = null;
        if (chat.chatType === 'DM' && ObjectId.isValid(userId)) {
          sender = await db.users().findOne(
            { _id: new ObjectId(userId) },
            { projection: { name: 1, displayPicture: 1 } }
          );
        }

        for (const recipientId of recipientIds) {
          const recipientChat = {
            ...chat,
            _id: chat._id.toString(),
            participants: participants.map(participant =>
              chat.chatType === 'DM' && participant.userId === userId
                ? { ...participant, displayPicture: sender?.displayPicture ?? participant.displayPicture ?? '' }
                : participant
            ),
            ...(chat.chatType === 'DM' ? { name: { [userId]: sender?.name ?? '' } } : {}),
          };

          await offlineMessageManager.broadcastMessage(
            { type: 'newChat', data: { chat: recipientChat, requestId: recipientId } },
            userId,
            [recipientId]
          );
        }

        ack?.();
      } catch (error) {
        console.error('Error in addChat event:', error);
        ack?.();
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

    // Every write here is scoped to the authenticated socket user (`userId`); the client's own
    // claim about who it is (`updates.userId`) is never used.
    socket.on('updateConversation', async (
      data: { id: string; updates: Record<string, unknown> },
      ack?: (result: { ok: boolean; error?: string }) => void
    ) => {
      const { id, updates } = data ?? {};
      try {
        if (!id || !ObjectId.isValid(id) || !updates || typeof updates !== 'object') {
          socket.emit('chatError', { error: 'Invalid update' });
          ack?.({ ok: false, error: 'Invalid update' });
          return;
        }

        if (updates.deleted) {
          if (updates.convo) {
            // Delete a whole chat
            const chatId = new ObjectId(id);
            const chat = await db.chats().findOne({ _id: chatId });

            if (!chat) {
              io.to(`user:${userId}`).emit('chatError', {
                error: 'Chat not found',
                chatId: id,
                updates: updates
              });
              ack?.({ ok: false, error: 'Chat not found' });
              return;
            }

            if (!canDeleteChat({
              chatType: chat.chatType,
              adminIds: chat.adminIds,
              userId,
              isMember: await isChatParticipant(id, userId),
            })) {
              // chatId + updates let the client restore the conversation it hid optimistically.
              const error = chat.chatType === 'Group' ? 'Only group admins can delete this group' : 'You are not a member of this chat';
              io.to(`user:${userId}`).emit('chatError', { error, chatId: id, updates: updates });
              ack?.({ ok: false, error });
              return;
            }

            // Remember who was in the chat: the rows are deleted below, and they all need telling.
            const memberRows = await db.chatParticipants()
              .find({ chatId: chatId.toString() }, { projection: { userId: 1 } })
              .toArray();
            const memberIds = Array.from(new Set(memberRows.map(row => row.userId).filter(Boolean)));

            // Collect attachment keys first: once the messages are deleted there is nothing left to read.
            const messages = await db.chatMessages()
              .find({ chatId: chatId.toString() }, { projection: { attachments: 1 } })
              .toArray();
            const attachmentKeys = messages.flatMap(message => message.attachments ?? []);

            await db.chats().deleteOne({ _id: chatId });
            await db.chatMessages().deleteMany({ chatId: chatId.toString() });

            // Best effort: the chat is already gone, so a storage failure must not undo that.
            if (attachmentKeys.length > 0) {
              try {
                await S3.deleteFileFromS3('files-for-chat', attachmentKeys);
              } catch (error) {
                console.error('Error deleting attachment from S3:', error);
              }
              await db.files().deleteMany({ key: { $in: attachmentKeys } });
            }

            const result2 = await db.chatParticipants().deleteMany({ chatId: chatId.toString() })
            // console.log(result2)
            const result3 = await db.readReceipts().deleteMany({ chatId: chatId.toString() })
            // console.log(result3)

            // Everyone else's copy of the chat is now dead; remove it from their screens too.
            try {
              await offlineMessageManager.broadcastMessage(
                { type: 'chatRemoved', data: { chatId: chatId.toString() } },
                undefined,
                memberIds
              );
            } catch (error) {
              console.error('Error announcing the deleted chat:', error);
            }
            ack?.({ ok: true });
            return;
          } else {
            // Delete one message for everyone: its sender, or an admin of a group
            const messageId = new ObjectId(id);
            const message = await db.chatMessages().findOne({ _id: messageId });
            if (!message) return;
            // Admin rights come from the stored chat, never from the client.
            const messageChat = ObjectId.isValid(message.chatId)
              ? await db.chats().findOne(
                  { _id: new ObjectId(message.chatId) },
                  { projection: { chatType: 1, adminIds: 1 } }
                )
              : null;
            const deletion = messageDeletion({
              senderId: message.sender?.id,
              userId,
              chatType: messageChat?.chatType,
              adminIds: messageChat?.adminIds,
            });
            if (!deletion) {
              socket.emit('chatError', {
                error: messageChat?.chatType === 'Group'
                  ? 'Only the sender or a group admin can delete this message'
                  : 'You can only delete your own messages',
              });
              return;
            }
            // Already a placeholder: nothing left to remove or announce.
            if (message.content?.endsWith('≤≤≤')) return;

            if (message.attachments && message.attachments.length > 0) {
              try {
                await S3.deleteFileFromS3('files-for-chat', message.attachments);
              } catch (error) {
                console.error('Error deleting attachment from S3:', error);
              }
            }

            // Keep a placeholder instead of removing the row, so every member (and anyone loading
            // the chat later) sees that something was deleted.
            const placeholder = deletion === 'admin' ? ADMIN_DELETED_CONTENT : SENDER_DELETED_CONTENT;
            await db.chatMessages().updateOne(
              { _id: messageId },
              { $set: { content: placeholder, attachments: [], mentions: [], messageType: 'Text' as MessageType } }
            );
            await db.readReceipts().deleteMany({ messageId: messageId.toString() });
            if (message.attachments && message.attachments.length > 0) {
              await db.files().deleteMany({ key: { $in: message.attachments } });
            }

            const members = await db.chatParticipants()
              .find({ chatId: message.chatId }, { projection: { userId: 1 } })
              .toArray();
            try {
              await offlineMessageManager.broadcastMessage(
                {
                  type: 'messageDeleted',
                  data: {
                    chatId: message.chatId,
                    messageId: id,
                    content: placeholder,
                    deletedBy: userId,
                    byAdmin: deletion === 'admin',
                  },
                },
                undefined,
                Array.from(new Set(members.map((row) => row.userId).filter(Boolean)))
              );
            } catch (error) {
              console.error('Error announcing the deleted message:', error);
            }
            return;
          }
        }

        // Per-user conversation state (pin, archive, unread...) on the caller's own row only.
        const changes = parseParticipantUpdates(updates);
        if (!changes) {
          socket.emit('chatError', { error: 'Invalid update' });
          return;
        }

        await db.chatParticipants().updateOne({ chatId: id, userId }, { $set: changes });
        io.to(`user:${userId}`).emit('conversationUpdated', { id: id, updates: { ...changes, userId } });
      } catch (error) {
        console.error('Error in updateConversation:', error);
        socket.emit('chatError', { error: 'Failed to update conversation' });
      }
    });

    // The user has opened the chat: record real read receipts for everything still pending,
    // then tell each message's sender so their ticks can turn blue.
    socket.on('markRead', async (data: { chatId?: string }, ack?: () => void) => {
      try {
        const chatId = data?.chatId;
        if (!chatId || !ObjectId.isValid(chatId) || !(await isChatParticipant(chatId, userId))) {
          ack?.();
          return;
        }

        // Readers who switched receipts off leave theirs pending, so nobody can see they read.
        const settings = await db.userSettings().findOne({ userId }, { projection: { showReadReceipts: 1 } });
        if (settings?.showReadReceipts === false) {
          ack?.();
          return;
        }

        const pending = await db.readReceipts().find(
          { chatId, userId, readAt: null },
          { projection: { messageId: 1 } }
        ).toArray();
        const messageIds = pending.map(receipt => receipt.messageId);
        if (messageIds.length === 0) {
          ack?.();
          return;
        }

        // Filter by the ids read above so a message that arrives meanwhile stays pending.
        const readAt = new Date().toISOString();
        await db.readReceipts().updateMany(
          { chatId, userId, messageId: { $in: messageIds }, readAt: null },
          { $set: { readAt } }
        );

        const objectIds = messageIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        const messages = await db.chatMessages()
          .find({ _id: { $in: objectIds } }, { projection: { 'sender.id': 1 } })
          .toArray();
        const byUser = new Map<string, string[]>();
        for (const message of messages) {
          const senderId = message.sender?.id;
          if (!senderId || senderId === userId) continue;
          byUser.set(senderId, [...(byUser.get(senderId) ?? []), message._id.toString()]);
        }

        // Live only: offline senders pick receipts up from the API the next time they load.
        for (const [senderId, ids] of byUser) {
          io.to(`user:${senderId}`).emit('messagesRead', { chatId, readerId: userId, messageIds: ids, readAt });
        }
        ack?.();
      } catch (error) {
        console.error('Error in markRead event:', error);
        ack?.();
      }
    });

    socket.on('chatMessage', async (data: MessageAttributes, ack?: () => void) => {
      // Acknowledge receipt right away. Processing (uploads, fan-out, push) can take seconds and
      // keeps running after the caller disconnects; failures reach the sender as 'chatError'.
      ack?.();
      await chatSocketHandler(data, db, userId);
    });

    socket.on('forwardMessages', async (data: unknown, ack?: (result: unknown) => void) => {
      try {
        ack?.(await forwardMessages(db, userId, data));
      } catch (error) {
        console.error('Error in forwardMessages event:', error);
        ack?.({ ok: false, error: 'Could not forward messages' });
      }
    });

    socket.on('typing', async (data: { user: Partial<UserSchema>, to: string }) => {
      try {
        // Respect "Show typing status": a user who turned it off never reveals typing.
        if (!(await getPrivacy(userId)).showTypingStatus) return;
        io.to(data.to).emit('userTyping', data);
      } catch (error) {
        console.error('Error in typing event:', error);
      }
    });

    socket.on('stopTyping', async (data: { user: Partial<UserSchema>, to: string }) => {
      try {
        if (!(await getPrivacy(userId)).showTypingStatus) return;
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

    // Announced by the API after an admin edits the group (details, admins, announcement mode).
    // The payload is re-read from the DB, so a forged event can only re-send what is stored.
    socket.on('chat:updated', async (data: { chatId?: string }, ack?: () => void) => {
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

        const participants = await db.chatParticipants().find({ chatId }, { projection: { userId: 1 } }).toArray();
        const memberIds = Array.from(new Set(participants.map(p => p.userId).filter(Boolean)));
        if (memberIds.length === 0) {
          ack?.();
          return;
        }

        await offlineMessageManager.broadcastMessage(
          {
            type: 'chatDetailsUpdated',
            data: {
              chatId,
              name: chat.name?.group ?? '',
              description: chat.groupDescription ?? '',
              displayPicture: chat.groupDisplayPicture ?? '',
              adminIds: chat.adminIds ?? [],
              onlyAdminsCanSend: chat.onlyAdminsCanSend ?? false,
            },
          },
          undefined,
          memberIds
        );
        ack?.();
      } catch (error) {
        console.error('Error in chat:updated event:', error);
        ack?.();
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
