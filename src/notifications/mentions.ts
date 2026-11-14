import { MongoDBClient } from '../mongodb.js';
import type { NotificationActor } from '../types.js';
import { actorFromUser } from './inApp.js';

const MENTION_PATTERN = /\B@[a-zA-Z0-9_]+\b/g;
const MAX_MENTIONS = 20;
const MAX_USERNAME_LENGTH = 30;

export function extractMentionUsernames(caption?: string | null): string[] {
  if (!caption) return [];

  const seen = new Set<string>();
  const usernames: string[] = [];

  for (const match of caption.matchAll(MENTION_PATTERN)) {
    const username = match[0].slice(1).toLowerCase();

    if (!username || username.length > MAX_USERNAME_LENGTH || seen.has(username)) continue;

    seen.add(username);
    usernames.push(username);
    if (usernames.length >= MAX_MENTIONS) break;
  }

  return usernames;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function resolveMentionedUsers(
  db: MongoDBClient,
  usernames: string[]
): Promise<NotificationActor[]> {
  const unique = Array.from(new Set(usernames.filter(Boolean)));
  if (unique.length === 0) return [];

  const pattern = new RegExp(`^(?:${unique.map(escapeRegex).join('|')})$`, 'i');

  const users = await db
    .users()
    .find(
      { username: pattern },
      {
        projection: {
          username: 1,
          firstname: 1,
          lastname: 1,
          displayPicture: 1,
          verified: 1,
        },
      }
    )
    .toArray();

  return users
    .map((user) => actorFromUser(user, String(user._id)))
    .filter((actor): actor is NotificationActor => Boolean(actor));
}

export async function resolveMentionedUserIds(
  db: MongoDBClient,
  caption?: string | null
): Promise<NotificationActor[]> {
  const usernames = extractMentionUsernames(caption);
  if (usernames.length === 0) return [];
  return resolveMentionedUsers(db, usernames);
}
