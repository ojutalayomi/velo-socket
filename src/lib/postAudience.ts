import type { MongoDBClient } from '../mongodb.js';
import { canReplyToPost, canViewPost, normalizeVisibility } from './postVisibility.js';

type PostLike = {
  Visibility?: unknown;
  WhoCanComment?: unknown;
  UserId?: unknown;
  scheduledFor?: unknown;
  ParentId?: unknown;
  Type?: unknown;
};

const ACTIVE = { $or: [{ follow: { $exists: false } }, { follow: true as const }] };

/** Accounts that follow `userId` and that `userId` follows back: "friends". */
export async function getMutualIds(db: MongoDBClient, userId: string): Promise<string[]> {
  const following = await db
    .followers()
    .find({ followerId: userId, ...ACTIVE }, { projection: { followedId: 1 } })
    .toArray();
  const followedIds = following.map((doc) => doc.followedId);
  if (followedIds.length === 0) return [];
  const back = await db
    .followers()
    .find({ followedId: userId, followerId: { $in: followedIds }, ...ACTIVE }, { projection: { followerId: 1 } })
    .toArray();
  return back.map((doc) => doc.followerId);
}

async function findPostAnywhere(db: MongoDBClient, postId: string): Promise<PostLike | null> {
  return (
    (await db.posts().findOne({ PostID: postId })) ||
    (await db.postsShares().findOne({ PostID: postId })) ||
    (await db.postsComments().findOne({ PostID: postId }))
  ) as PostLike | null;
}

export type ThreadAccess = {
  /** The actor may read the post (and so its replies). */
  visible: boolean;
  /** The actor may add a reply. */
  canReply: boolean;
  /** Who should hear about activity on the thread: null means everyone online, otherwise just these accounts. */
  audience: string[] | null;
};

/**
 * What `actorId` may do with a post. A reply belongs to the post at the top of its thread, and that
 * post's audience decides: its visibility, who can reply, and who is told about new activity.
 */
export async function threadAccess(db: MongoDBClient, post: PostLike, actorId?: string): Promise<ThreadAccess> {
  let root: PostLike = post;
  for (let depth = 0; depth < 8 && root.Type === 'comment' && typeof root.ParentId === 'string' && root.ParentId; depth++) {
    const parent = await findPostAnywhere(db, root.ParentId);
    if (!parent) break;
    root = parent;
  }

  const authorId = typeof root.UserId === 'string' ? root.UserId : '';
  const isAuthor = !!actorId && actorId === authorId;
  // Nobody reacts to, replies to or shares a post that is not live yet, not even its author.
  if (root.scheduledFor) return { visible: false, canReply: false, audience: [authorId] };

  const visibility = normalizeVisibility(root.Visibility);
  if (visibility === 'everyone' && root.Visibility !== 'none' && root.WhoCanComment !== 'friends') {
    return { visible: true, canReply: canReplyToPost(root, actorId, false), audience: null };
  }

  const mutualIds = authorId ? await getMutualIds(db, authorId) : [];
  const isMutual = !!actorId && mutualIds.includes(actorId);
  const audience = visibility === 'me' ? [authorId] : visibility === 'friends' ? [authorId, ...mutualIds] : null;
  return {
    visible: canViewPost(root, actorId, isMutual),
    canReply: canReplyToPost(root, actorId, isMutual),
    audience,
  };
}
