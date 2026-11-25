import { ObjectId } from 'mongodb';

import type { PostAuthorFields } from './postAuthor.js';
import { withAuthor } from './postAuthor.js';
import type { SenderAccount } from './senderProfile.js';

/** The slice of a users collection needed here (the app uses both typed and raw collections). */
interface UsersLike {
  find(filter: object, options?: object): { toArray(): Promise<unknown[]> };
}

/** Fills in each post's author from the user's current account, in one query for the whole list. */
export async function withAuthors<T extends object>(
  users: UsersLike,
  posts: T[]
): Promise<(T & PostAuthorFields)[]> {
  const ids = Array.from(
    new Set(posts.map((p) => (p as { UserId?: string }).UserId).filter((id): id is string => !!id && ObjectId.isValid(id)))
  );
  const accounts = new Map<string, SenderAccount>();
  if (ids.length > 0) {
    const rows = (await users
      .find(
        { _id: { $in: ids.map((id) => new ObjectId(id)) } },
        { projection: { name: 1, firstname: 1, lastname: 1, username: 1, displayPicture: 1, verified: 1 } }
      )
      .toArray()) as ({ _id: ObjectId } & SenderAccount)[];
    for (const row of rows) accounts.set(String(row._id), row);
  }
  return posts.map((post) => {
    const userId = (post as { UserId?: string }).UserId;
    return withAuthor(post as T & Partial<PostAuthorFields>, userId ? accounts.get(userId) : undefined);
  });
}
