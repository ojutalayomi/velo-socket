import { ObjectId } from 'mongodb';

export const MAX_FORWARD_MESSAGES = 20;
export const MAX_FORWARD_CHATS = 5;

/** Content marker the clients use for a message its sender deleted. */
const DELETED_MARKER = '≤≤≤';

export type ForwardRequest = { messageIds: string[]; chatIds: string[] };

/** Validates a `forwardMessages` payload; ids are de-duplicated and must be real ObjectIds. */
export function parseForwardRequest(
  data: unknown
): ({ ok: true } & ForwardRequest) | { ok: false; error: string } {
  const input = (data ?? {}) as { messageIds?: unknown; chatIds?: unknown };

  const clean = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const ids = Array.from(new Set(value));
    return ids.every((id) => typeof id === 'string' && ObjectId.isValid(id)) ? (ids as string[]) : null;
  };

  const messageIds = clean(input.messageIds);
  const chatIds = clean(input.chatIds);
  if (!messageIds || !chatIds) return { ok: false, error: 'Invalid forward request' };
  if (messageIds.length === 0 || chatIds.length === 0) {
    return { ok: false, error: 'Choose at least one message and one chat' };
  }
  if (messageIds.length > MAX_FORWARD_MESSAGES) {
    return { ok: false, error: `You can forward up to ${MAX_FORWARD_MESSAGES} messages at once` };
  }
  if (chatIds.length > MAX_FORWARD_CHATS) {
    return { ok: false, error: `You can forward to up to ${MAX_FORWARD_CHATS} chats at once` };
  }
  return { ok: true, messageIds, chatIds };
}

/**
 * Message types that only make sense in the chat they were sent in: a call record, a poll (and the
 * votes and results that belong to it), a chat announcement. Everything else can be forwarded.
 */
export const NON_FORWARDABLE_TYPES = ['Call', 'Poll', 'PollResponse', 'PollEnd', 'PollResult', 'Announcement'];

/** A deleted message, one with nothing left to show, or one of the types above is never forwarded. */
export function isForwardable(message: { content?: string; attachmentCount: number; messageType?: string; viewOnce?: boolean }): boolean {
  if (message.viewOnce) return false;
  if (message.messageType && NON_FORWARDABLE_TYPES.includes(message.messageType)) return false;
  const content = message.content ?? '';
  if (content.endsWith(DELETED_MARKER)) return false;
  return content.trim().length > 0 || message.attachmentCount > 0;
}
