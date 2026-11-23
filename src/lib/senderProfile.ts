import type { MessageAttributes } from '../types.js';

export interface SenderAccount {
  name?: string;
  firstname?: string;
  lastname?: string;
  username?: string;
  displayPicture?: string;
  verified?: boolean;
}

/**
 * The sender stored on a message. It is built from the account behind the authenticated
 * connection, never from the client's payload, so nobody can post as someone else or borrow
 * their name, picture or verified badge.
 */
export function senderFromAccount(userId: string, account: SenderAccount): MessageAttributes['sender'] {
  return {
    id: userId,
    name: account.name || [account.firstname, account.lastname].filter(Boolean).join(' ') || account.username || '',
    username: account.username ?? '',
    displayPicture: account.displayPicture ?? '',
    verified: account.verified === true,
  };
}

/**
 * What is stored on a message: only who sent it. Names, pictures and the verified badge change,
 * so they are read from the account when a message is read, not copied into every message.
 * (Messages saved before this carry a full copy, which is only a fallback.)
 */
export const storedSender = (sender: { id: string }) => ({ id: sender.id }) as MessageAttributes['sender'];

/** The sender to show: the current account wins; a stored copy only fills in for a missing account. */
export function mergeSender(
  stored: Partial<MessageAttributes['sender']> & { id: string },
  account?: SenderAccount | null
): MessageAttributes['sender'] {
  if (!account) {
    return {
      id: stored.id,
      name: stored.name || 'Deleted user',
      displayPicture: stored.displayPicture ?? '',
      username: stored.username ?? '',
      verified: stored.verified ?? false,
    };
  }
  return senderFromAccount(stored.id, account);
}
