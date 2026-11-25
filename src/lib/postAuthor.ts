import type { SenderAccount } from './senderProfile.js';

/** The copy of the author's profile that older posts, comments and shares carry in every document. */
export const AUTHOR_FIELDS = ['NameOfPoster', 'Username', 'DisplayPicture', 'Verified'] as const;

export interface PostAuthorFields {
  NameOfPoster: string;
  Username: string;
  DisplayPicture: string;
  Verified: boolean;
}

/** The author's profile as posts show it, read from their account. */
export function authorFromAccount(account: SenderAccount): PostAuthorFields {
  return {
    NameOfPoster: account.name || [account.firstname, account.lastname].filter(Boolean).join(' ') || account.username || '',
    Username: account.username ?? '',
    DisplayPicture: account.displayPicture ?? '',
    Verified: account.verified === true,
  };
}

/**
 * The author to show: the current account wins. A stored copy only fills in when the account is
 * gone (a deleted user), so old content keeps a name instead of going blank.
 */
export function withAuthor<T extends object>(input: T, account?: SenderAccount | null): T & PostAuthorFields {
  const post = input as T & Partial<PostAuthorFields>;
  if (!account) {
    return {
      ...post,
      NameOfPoster: post.NameOfPoster || 'Deleted user',
      Username: post.Username ?? '',
      DisplayPicture: post.DisplayPicture ?? '',
      Verified: post.Verified ?? false,
    };
  }
  return { ...post, ...authorFromAccount(account) };
}

/** A post document as it is saved: who wrote it is the UserId alone. */
export function withoutAuthor<T extends object>(input: T): Omit<T, keyof PostAuthorFields> {
  const rest = { ...input } as Partial<PostAuthorFields>;
  for (const field of AUTHOR_FIELDS) delete rest[field];
  return rest as Omit<T, keyof PostAuthorFields>;
}
