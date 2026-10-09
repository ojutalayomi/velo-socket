import { ObjectId } from "mongodb";

import { MongoDBClient } from "../mongodb.js";
import { Attachment, ChatType, MessageAttributes, MessageSchema, MessageType, msgStatus, Reaction } from "../types.js";

/**
 * Represents a simplified chat message object in the application's database.
 */
export class ChatMessage implements MessageSchema {
    public _id: ObjectId;
    public chatId: string;
    public receiverId: string;
    public content: string; // This is the field we want to populate
    public timestamp: string;
    public messageType: MessageType;
    public isRead: Record<string, boolean>;
    public chatType: ChatType;
    public sender: { id: string; name: string; displayPicture: string; username: string; verified: boolean; };
    public reactions: Reaction[];
    public attachments: string[];
    public quotedMessageId: string;
    public status: msgStatus;
  
    // constructor to force use of factory methods
    constructor(data: MessageAttributes) {
      // Ensure a valid MongoDB ObjectId is always set
      this._id = (typeof data._id === "string" && ObjectId.isValid(data._id))
        ? new ObjectId(data._id)
        : new ObjectId();
      this.chatId = data.chatId;
      this.receiverId = data.receiverId;
      this.content = data.content;
      this.timestamp = data.timestamp || new Date().toISOString(); // Current time
      this.messageType = data.messageType;
      this.isRead = data.isRead || {};
      this.sender = data.sender;
      this.reactions = data.reactions;
      this.attachments = (data.attachments || []).map(attachment => attachment.key);
      this.quotedMessageId = data.quotedMessageId;
      this.status = data.status;
      this.chatType = data.chatType;
    }

    public toMessageAttributes(attachments: Attachment[] = []): MessageAttributes {
        return {
            _id: this._id.toString(),
            chatId: this.chatId,
            receiverId: this.receiverId,
            content: this.content,
            timestamp: this.timestamp,
            messageType: this.messageType,
            isRead: this.isRead,
            sender: this.sender,
            reactions: this.reactions,
            attachments,
            quotedMessageId: this.quotedMessageId,
            status: this.status,
            chatType: this.chatType,
        };
    }
  
    /**
     * Factory method to create a ChatMessage instance from a raw OpenRouter response.
     */
    public static async fromOpenRouterResponse(
        apiResponse: any,
        chatId: string,
        humanUserId: string,
        botUserId: string,
        messageType: MessageType,
        chatType: ChatType
    ): Promise<ChatMessage | null> {
        const content = apiResponse?.choices?.[0]?.message?.content;
        const responseText = Array.isArray(content)
            ? content
                .map((part: any) => {
                    if (typeof part === 'string') {
                        return part;
                    }

                    return part?.text || '';
                })
                .join('\n')
                .trim()
            : (typeof content === 'string' ? content.trim() : '');
        
        if (!responseText) {
            console.error("OpenRouter response is empty or invalid.");
            return null;
        }

        const db = await new MongoDBClient().init();
        const users = db.users();
        const botUser = await users.findOne({ _id: new ObjectId(botUserId) });
        
        if (!botUser) {
            console.error("Bot user not found.");
            return null;
        }

        // 2. Prepare data for the new ChatMessage object
        const botResponseData = {
            _id: "",
            chatId,
            // The human user is the receiver of the bot's message
            receiverId: humanUserId, 
            content: responseText,
            messageType,
            isRead: {
                [humanUserId]: false, // Human user hasn't read it
                [botUserId]: true,    // Bot considers its own message handled/read
            },
            sender: { 
                id: botUser._id.toString(), 
                name: botUser.name, 
                displayPicture: botUser.displayPicture || "", 
                username: botUser.username, 
                verified: botUser.verified || false 
            },
            reactions: [],
            attachments: [],
            quotedMessageId: "",
            status: "sent" as msgStatus,
            chatType,
            timestamp: new Date().toISOString(),
        };

        // 3. Create and return the final application message object
        return new ChatMessage(botResponseData);
    }
}