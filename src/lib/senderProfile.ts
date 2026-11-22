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
