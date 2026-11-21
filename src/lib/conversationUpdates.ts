/** Per-user fields a client may change on its own participant row. */
export type ParticipantUpdates = {
  pinned?: boolean;
  archived?: boolean;
  favorite?: boolean;
  unreadCount?: number;
};

const BOOLEAN_FIELDS = ['pinned', 'archived', 'favorite'] as const;
const MAX_UNREAD = 1_000_000;

/**
 * Validates an `updateConversation` payload for the caller's own participant row. Anything not
 * whitelisted (including `userId`, `chatId`, or arbitrary keys) is rejected, never written.
 * Returns null when the payload is invalid or empty.
 */
export function parseParticipantUpdates(updates: unknown): ParticipantUpdates | null {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return null;

  const input = updates as Record<string, unknown>;
  const result: ParticipantUpdates = {};

  for (const [key, value] of Object.entries(input)) {
    // `userId` is tolerated for older clients but ignored: identity comes from the socket.
    if (key === 'userId') continue;

    if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') return null;
      result[key as (typeof BOOLEAN_FIELDS)[number]] = value;
    } else if (key === 'unreadCount') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_UNREAD) return null;
      result.unreadCount = value;
    } else {
      return null;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Any member may delete a DM; a group can only be deleted by one of its admins. */
export function canDeleteChat(params: {
  chatType?: string;
  adminIds?: string[];
  userId: string;
  isMember: boolean;
}): boolean {
  if (!params.isMember) return false;
  return params.chatType === 'Group' ? Boolean(params.adminIds?.includes(params.userId)) : true;
}

/** Content shown in place of a message an admin removed; same trailing marker the clients use. */
export const ADMIN_DELETED_CONTENT = 'This message was deleted by an admin.≤≤≤';

/** Stored when a sender deletes their own message; each client words it for its own viewer. */
export const SENDER_DELETED_CONTENT = 'This message was deleted.≤≤≤';

export type MessageDeletion = 'sender' | 'admin';

/**
 * Who may delete a message for everyone: its sender anywhere, and an admin of a group.
 * In a DM (or any non-group chat) only the sender can.
 */
export function messageDeletion(params: {
  senderId?: string;
  userId: string;
  chatType?: string;
  adminIds?: string[];
}): MessageDeletion | null {
  if (params.senderId && params.senderId === params.userId) return 'sender';
  if (params.chatType === 'Group' && params.adminIds?.includes(params.userId)) return 'admin';
  return null;
}
