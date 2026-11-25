import { ObjectId } from "mongodb";
import {
  canonicalKlipyContent,
  canonicalLocationContent,
  canonicalPollContent,
  contactContent,
  messageDisplayText,
  requestedContactId,
} from './postExtras.js';
import { offlineMessageManager } from "../offline-messages.js";
import { io } from "../socket.js";
import { MessageAttributes, AttachmentSchema, msgStatus, MessageType, MentionNotification } from "../types.js";
import { ChatMessage } from "./ChatMessage.js";
import * as S3 from "../s3.js";
import { MongoDBClient } from "../mongodb.js";
import { notifyChatMessage } from "../notifications/chat.js";
import { loadActor, recordNotification } from "../notifications/inApp.js";
import { chatUrl } from "../notifications/targets.js";
import { redis } from "../redis.js";
import {
  canMentionEveryone,
  everyoneRecipients,
  mentionsAi,
  mentionsEveryone,
  sanitizeMentions,
} from "../notifications/groupMentions.js";
import { replyAsAi } from "./groupAi.js";
import { canSendMessage } from "./chatPermissions.js";
import { senderFromAccount, storedSender } from "./senderProfile.js";
import { deriveMessageType } from "./messageType.js";
import { resolveStatusReply } from "./statusReply.js";
import { unreadIncrement } from "./unreadCounts.js";

export const chatSocketHandler = async (
    data: MessageAttributes,
    db: MongoDBClient,
    authenticatedSenderId?: string,
    options: { trustedSender?: boolean; forwarded?: boolean; preparedAttachments?: AttachmentSchema[] } = {}
) => {
    const senderId = authenticatedSenderId || data.sender?.id;
    try {
      // console.log('Message')
      // console.log(data)
      console.log(`Processing chat message from ${senderId} to ${data.receiverId} in chat ${data.chatId}`);

      // Validate required data
      if (!data.chatId || !senderId || !data.receiverId) {
        console.error('chatMessage: Missing required fields', { chatId: data.chatId, senderId: senderId, receiverId: data.receiverId });
        io.to(`user:${senderId}`).emit('chatError', { error: 'Missing required fields' });
        return;
      }

      // Reject non-members before any upload or write happens.
      // Internal senders (the AI bot) post into groups without being members.
      const senderMembership = options.trustedSender || await db.chatParticipants().findOne(
        { chatId: data.chatId, userId: senderId },
        { projection: { _id: 1 } }
      );
      if (!senderMembership) {
        console.warn(`chatMessage rejected; ${senderId} is not in chat ${data.chatId}`);
        io.to(`user:${senderId}`).emit('chatError', { error: 'You are not a member of this chat' });
        return;
      }

      // Who sent it is decided by the connection, not by the payload: a client must not be able to
      // post as someone else or borrow their name, picture or verified badge. The AI bot (trusted)
      // supplies its own sender.
      if (authenticatedSenderId && !options.trustedSender) {
        const account = ObjectId.isValid(authenticatedSenderId)
          ? await db.users().findOne(
              { _id: new ObjectId(authenticatedSenderId) },
              { projection: { name: 1, firstname: 1, lastname: 1, username: 1, displayPicture: 1, verified: 1 } }
            )
          : null;
        if (!account) {
          io.to(`user:${senderId}`).emit('chatError', { error: 'Your account could not be found' });
          return;
        }
        data.sender = senderFromAccount(authenticatedSenderId, account);
      }

      // A retry of a message that was already saved (same id) must not repeat any side effects.
      if (typeof data._id === 'string' && ObjectId.isValid(data._id)) {
        const saved = await db.chatMessages().findOne({ _id: new ObjectId(data._id) }, { projection: { _id: 1 } });
        if (saved) {
          console.warn(`chatMessage ${data._id} already saved; ignoring duplicate`);
          return;
        }
      }

      // Announcement mode is read from the stored chat, never from the client's chatType.
      const group = !options.trustedSender && ObjectId.isValid(data.chatId)
        ? await db.chats().findOne(
            { _id: new ObjectId(data.chatId) },
            { projection: { chatType: 1, adminIds: 1, onlyAdminsCanSend: 1 } }
          )
        : null;
      if (group && !canSendMessage({
        chatType: group.chatType,
        onlyAdminsCanSend: group.onlyAdminsCanSend,
        adminIds: group.adminIds,
        userId: senderId,
      })) {
        io.to(`user:${senderId}`).emit('chatError', { error: 'Only admins can send messages in this group' });
        return;
      }

      // Call history cards are written by the call server only, never accepted from a client.
      if (data.messageType === 'Call' && !options.trustedSender) {
        io.to(`user:${senderId}`).emit('chatError', { error: 'That message type is not allowed' });
        return;
      }

      // Poll messages carry their definition as JSON; only a valid poll may use the Poll type.
      if (data.messageType === 'Poll') {
        const canonical = canonicalPollContent(data.content);
        if (!canonical) {
          io.to(`user:${senderId}`).emit('chatError', { error: 'That poll is not valid' });
          return;
        }
        data.content = canonical;
      }

      // GIFs and stickers come from KLIPY; only its own URLs are accepted.
      if ((data.messageType === 'AnimatedGIF' || data.messageType === 'Sticker') && !options.trustedSender && !options.forwarded) {
        const canonical = canonicalKlipyContent(data.content);
        if (!canonical) {
          io.to(`user:${senderId}`).emit('chatError', { error: 'That GIF or sticker is not valid' });
          return;
        }
        data.content = canonical;
      }

      // A shared location must be valid, and a shared contact is rebuilt from the real account.
      if (data.messageType === 'Location' && !options.trustedSender) {
        const canonical = canonicalLocationContent(data.content);
        if (!canonical) {
          io.to(`user:${senderId}`).emit('chatError', { error: 'That location is not valid' });
          return;
        }
        data.content = canonical;
      }
      if (data.messageType === 'Contact' && !options.trustedSender && !options.forwarded) {
        const contactId = requestedContactId(data.content);
        const contactUser = contactId
          ? await db.users().findOne({ _id: new ObjectId(contactId) })
          : null;
        if (!contactUser) {
          io.to(`user:${senderId}`).emit('chatError', { error: 'That contact could not be found' });
          return;
        }
        data.content = contactContent(contactUser);
      }

      // Handle multiple file uploads (if attachments exist)
      // Forwarded messages arrive with their files already copied in storage.
      let attachmentsWithUrls: AttachmentSchema[] = options.preparedAttachments ?? [];
      if (!options.preparedAttachments && data.attachments && data.attachments.length > 0) {
        // Upload each file to S3 and store the URLs
        for (const file of data.attachments) {
          try {
            const fileBuffer = Buffer.from(file.data || ''); // Assuming file.data is the file content as a Buffer
            const fileUrl = await S3.uploadFileToS3('files-for-chat',fileBuffer, file.key, file.type);
            attachmentsWithUrls.push({
              _id: new ObjectId(),
              name: file.name,
              key: file.key,
              type: file.type,
              url: fileUrl, // Add the S3 URL to the attachment
              size: Buffer.byteLength(fileBuffer),
              uploadedAt: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error uploading file to S3:', error);
            attachmentsWithUrls.push({
              _id: new ObjectId(),
              name: file.name,
              key: file.key,
              type: file.type,
              url: "", // Mark the file as failed to upload
              size: file.size || 0,
              uploadedAt: new Date().toISOString()
            });
          }
        }
      }

      // The type comes from the content and attachments, never from the client's claim. Only a
      // poll (validated above), a trusted sender or a forward may ask for a structured type.
      const requestedType =
        options.trustedSender ||
        options.forwarded ||
        data.messageType === 'Poll' ||
        data.messageType === 'Location' ||
        data.messageType === 'AnimatedGIF' ||
        data.messageType === 'Sticker' ||
        data.messageType === 'Contact'
          ? data.messageType
          : data.messageType === 'Markdown'
            ? 'Markdown'
            : 'Text';
      data.messageType = deriveMessageType({
        content: data.content,
        attachments: attachmentsWithUrls,
        requested: requestedType,
      });

      // `@all` is decided here from the stored group, never from what the client claims.
      const everyoneAllowed = !options.trustedSender && !options.forwarded && mentionsEveryone(data.content) && canMentionEveryone({
        chatType: group?.chatType,
        adminIds: group?.adminIds,
        senderId,
      });
      const mentions = sanitizeMentions(data.mentions, everyoneAllowed);

      // Messages Collection

      const message = new ChatMessage({
        _id: data._id,
        chatId: data.chatId, // Reference to the chat in DM collection
        sender: data.sender,
        receiverId: data.receiverId,
        content: data.content,
        timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
        chatType: data.chatType,
        reactions: data.reactions || [],
        attachments: attachmentsWithUrls || [],
        quotedMessageId: data.quotedMessageId,
        forwarded: options.forwarded,
        // A reply to a status carries a snapshot of it; the client only names the status.
        statusReply: options.trustedSender || options.forwarded ? undefined : await resolveStatusReply(db, senderId, data),
        status: 'sent' as msgStatus,
        messageType: data.messageType as MessageType,
        mentions: mentions.map((mention) => ({
          userId: String(mention.userId),
          username: String(mention.username),
        })),
      });
      
      // The roster always comes from the DB; a client must not be able to name its own recipients.
      const chatsParticipants = await db.chatParticipants().find({ chatId: message.chatId }).toArray();
      
      // Validate participants data structure
      if (chatsParticipants && chatsParticipants.length > 0) {
        // Filter out invalid participants
        const validParticipants = chatsParticipants.filter(participant => 
          participant && 
          participant.userId && 
          typeof participant.userId === 'string' && 
          participant.userId.trim() !== ''
        );
        
        if (validParticipants.length === 0) {
          console.warn('No valid participants found for chat message');
          chatsParticipants.length = 0; // Reset to empty array
        } else if (validParticipants.length !== chatsParticipants.length) {
          console.warn(`Filtered out ${chatsParticipants.length - validParticipants.length} invalid participants`);
          chatsParticipants.splice(0, chatsParticipants.length, ...validParticipants);
        }
      }
      
      // Only proceed if we have valid participants
      if (chatsParticipants && chatsParticipants.length > 0) {
        const participantUpdates = chatsParticipants.map((participant) => ({
          updateOne: {
            filter: { chatId: message.chatId.toString(), userId: participant.userId },
            update: {
              $set: {
                lastMessageId: message?._id?.toString() || '',
                lastUpdated: new Date().toISOString()
              },
              $inc: {
                unreadCount: unreadIncrement(participant.userId, senderId)
              }
            }
          }
        }));

        // Only perform bulk write if we have valid updates
        if (participantUpdates.length > 0) {
          // Validate the operations array structure
          const validOperations = participantUpdates.filter(op => 
            op && 
            op.updateOne && 
            op.updateOne.filter && 
            op.updateOne.update &&
            op.updateOne.filter.chatId && 
            op.updateOne.filter.userId &&
            op.updateOne.update.$set && 
            op.updateOne.update.$inc
          );
          
          if (validOperations.length === 0) {
            console.error('No valid operations found for bulkWrite');
            // Fallback to individual updates
            for (const participant of chatsParticipants) {
              try {
                await db.chatParticipants().updateOne(
                  { chatId: message.chatId.toString(), userId: participant.userId },
                  {
                    $set: {
                      lastMessageId: message?._id?.toString() || '',
                      lastUpdated: new Date().toISOString()
                    },
                    $inc: {
                      unreadCount: unreadIncrement(participant.userId, senderId)
                    }
                  }
                );
              } catch (updateError) {
                console.error(`Error updating participant ${participant.userId}:`, updateError);
              }
            }
          } else {
            try {
              await db.chatParticipants().bulkWrite(validOperations);
            } catch (error) {
              console.error('Error in bulkWrite operation:', error);
              // Fallback to individual updates if bulkWrite fails
              for (const participant of chatsParticipants) {
                try {
                  await db.chatParticipants().updateOne(
                    { chatId: message.chatId.toString(), userId: participant.userId },
                    {
                      $set: {
                        lastMessageId: message?._id?.toString() || '',
                        lastUpdated: new Date().toISOString()
                      },
                      $inc: {
                        unreadCount: unreadIncrement(participant.userId, senderId)
                      }
                    }
                  );
                } catch (updateError) {
                  console.error(`Error updating participant ${participant.userId}:`, updateError);
                }
              }
            }
          }
        }
      }

      // Update chat with last message info
      try {
        let chatObjectId: ObjectId;
        try {
          chatObjectId = new ObjectId(message.chatId);
        } catch (error) {
          console.error('Invalid chat ID format:', message.chatId);
          return;
        }
        
        await db.chats().updateOne(
          { _id: chatObjectId }, 
          { 
            $set: { 
              lastMessageId: message?._id?.toString() || '', 
              lastUpdated: new Date().toISOString() 
            } 
          }
        );
      } catch (error) {
        console.error('Error updating chat:', error);
      }

      try {
        // Only the sender's id is stored; their name, picture and badge are read from the account.
        await db.chatMessages().insertOne({ ...message, sender: storedSender(message.sender), updatedAt: new Date().toISOString() } as typeof message);
      } catch (error) {
        // The same message id arriving twice is a retry of one already saved; do nothing.
        if ((error as { code?: number })?.code === 11000) {
          console.warn(`chatMessage ${message._id} already saved; ignoring duplicate`);
          return;
        }
        console.error('Error inserting chat message:', error);
        io.to(`user:${senderId}`).emit('chatError', { error: 'Failed to save message' });
        return;
      }

      // Files Collection
      try {
        if (attachmentsWithUrls.length > 0) {
          await db.files().insertMany(attachmentsWithUrls);
        }
      } catch (error) {
        console.error('Error inserting files:', error);
        io.to(`user:${senderId}`).emit('chatError', { error: 'Failed to save files' });
        return;
      }

      // Read receipts
      if (chatsParticipants && chatsParticipants.length > 0) {
        message.isRead = chatsParticipants.reduce((acc, participant) => {
          acc[participant.userId] = false;
          return acc;
        }, {} as { [key: string]: boolean });
        message.isRead[senderId] = true;

        // Only insert read receipts if we have participants
        try {
          await db.readReceipts().insertMany(
            chatsParticipants.map((participant) => ({
              _id: new ObjectId(),
              messageId: message?._id?.toString() || '',
              userId: participant.userId,
              chatId: message.chatId.toString(),
              // Only the sender has read their own message; everyone else is pending until markRead.
              readAt: participant.userId === senderId ? new Date().toISOString() : null
            }))
          );
        } catch (error) {
          console.error('Error inserting read receipts:', error);
          // Continue processing even if read receipts fail
        }
      } else {
        // Initialize isRead with just the sender if no participants
        message.isRead = { [senderId]: true };
      }

      // Process mentions and notify mentioned users (explicit @username plus an accepted @all)
      const everyoneIds = everyoneAllowed ? everyoneRecipients(chatsParticipants, senderId) : [];
      if (mentions.length > 0 || everyoneIds.length > 0) {
        try {
          // Build the set of valid participant user IDs for this chat (used for group validation)
          let participantUserIds: Set<string> | null = null;
          if (data.chatType === 'Group' || data.chatType === 'Channels') {
            const participants = await db.chatParticipants().find({ chatId: data.chatId }).toArray();
            participantUserIds = new Set(participants.map(p => p.userId));
          }

          const mentionNotification: MentionNotification = {
            messageId: message._id?.toString() || '',
            chatId: message.chatId,
            chatType: message.chatType,
            mentionedBy: {
              userId: message.sender.id,
              username: message.sender.username,
              displayPicture: message.sender.displayPicture,
            },
            content: message.content,
            timestamp: message.timestamp,
          };

          const mentionActor = await loadActor(db, senderId);

          const targets = new Set<string>(everyoneIds);
          for (const mention of mentions) {
            // Never notify the sender about their own mention
            if (mention.userId === senderId) continue;

            // For group/channel chats, skip users who aren't participants (this also drops the `all` marker)
            if (participantUserIds && !participantUserIds.has(mention.userId)) continue;

            targets.add(mention.userId);
          }

          for (const recipientId of targets) {
            await offlineMessageManager.broadcastMessage(
              { type: 'mentionNotification', data: mentionNotification },
              undefined,
              [recipientId]
            );

            if (mentionActor) {
              try {
                await recordNotification(db, {
                  recipientId,
                  actorId: senderId,
                  actor: mentionActor,
                  type: 'mention',
                  targetType: 'chat_message',
                  targetId: mentionNotification.messageId,
                  url: chatUrl(data.chatId, data.chatType),
                  snippet: messageDisplayText(data.messageType, data.content),
                  chatId: data.chatId,
                  chatType: data.chatType,
                });
              } catch (error) {
                console.error('Error writing chat mention notification:', error);
              }
            }
          }

        } catch (error) {
          console.error('Error processing mention notifications:', error);
        }
      }

      if (data.chatType === 'Group') {
        try {
          // Live emit to group members in room and Queue for offline group members: fetch participants
          const participants = await db.chatParticipants().find({ chatId: data.chatId }).toArray();
          const userIds = participants.map(p => p.userId).filter(Boolean);
          await offlineMessageManager.broadcastMessage({
            type: 'newMessage',
            data: message.toMessageAttributes(attachmentsWithUrls)
          }, undefined, userIds);
        } catch (error) {
          console.error('Error queuing group message for offline users:', error);
        }
      } else {
        try {
          // Live emit to sender and receiver
          // Queue for offline sender/receiver
          // Recipients come from the stored roster, like groups; the client's receiverId is not trusted.
          const rosterIds = (chatsParticipants ?? []).map(participant => participant.userId);
          const targets = rosterIds.length > 0 ? Array.from(new Set([senderId, ...rosterIds])) : [senderId];
          await offlineMessageManager.broadcastMessage({
            type: 'newMessage',
            data: message.toMessageAttributes(attachmentsWithUrls)
          }, undefined, targets);
        } catch (error) {
          console.error('Error queuing direct message for offline users:', error);
        }
      }

      // A call card is history, not news: missed calls already send their own push.
      try {
        if (data.messageType !== 'Call') await notifyChatMessage({
          db,
          redis,
          chatId: data.chatId,
          senderId,
          messageId: message._id?.toString() || '',
          content: messageDisplayText(data.messageType, data.content),
          attachmentCount: attachmentsWithUrls.length,
          mentions,
          everyone: everyoneAllowed,
        });
      } catch (error) {
        console.error('Error sending chat push notifications:', error);
      }

      // `@ai` in a group asks the assistant to reply. Not awaited: the model call is slow and
      // must not delay delivery. Bot replies are trusted senders and never re-trigger this.
      if (!options.trustedSender && !options.forwarded && data.chatType === 'Group' && mentionsAi(data.content)) {
        void replyAsAi({
          db,
          redis,
          chatId: data.chatId,
          trigger: message.toMessageAttributes(attachmentsWithUrls),
          deliver: (reply, botId) => chatSocketHandler(reply, db, botId, { trustedSender: true }),
        }).catch((error) => console.error('Error replying as AI:', error));
      }
    } catch (error) {
      console.error('Error in chatMessage handler:', error);
      io.to(`user:${senderId}`).emit('chatError', { error: 'Failed to process chat message' });
    }
}