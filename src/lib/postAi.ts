import { ObjectId } from 'mongodb';
import type Redis from 'ioredis';

import { MongoDBClient } from '../mongodb.js';
import { offlineMessageManager } from '../offline-messages.js';
import { loadActor, recordNotification } from '../notifications/inApp.js';
import { mentionsAi } from '../notifications/groupMentions.js';
import { contentUrl } from '../notifications/targets.js';
import { aiModel, openRouter } from './openRouter.js';
import { buildPostAiPrompt, type PostAiContext, type PostLike } from './postAiPrompt.js';

export type { PostLike } from './postAiPrompt.js';

// Room for hidden reasoning as well as the (short) answer; the prompt keeps replies brief.
const MAX_REPLY_TOKENS = 3000;
const MAX_REPLY_CHARS = 1000;
const MAX_THREAD_DEPTH = 3;
const MAX_SIBLING_COMMENTS = 8;
/** One request per user in this window, so mentioning @ai cannot run up the model bill. */
const COOLDOWN_SECONDS = 10;

const SYSTEM_PROMPT =
  'You are Velo AI, an assistant on Velo, a social app. Someone mentioned @ai in a post, comment or ' +
  'quote, and your answer is posted publicly as a comment under it. Reply to what they asked, using ' +
  'the surrounding post, thread and replies as context. Be concise (a few sentences), friendly and ' +
  'accurate. Plain text; use Markdown only when it clearly helps. Do not start with your own name and ' +
  'do not repeat the question. If you cannot tell what is being asked, ask one short clarifying question.';

type Collections = {
  posts: ReturnType<MongoDBClient['posts']>;
  shares: ReturnType<MongoDBClient['postsShares']>;
  comments: ReturnType<MongoDBClient['postsComments']>;
};

async function findPost(c: Collections, postId: string) {
  if (!postId) return null;
  const hit =
    (await c.posts.findOne({ PostID: postId })) ??
    (await c.shares.findOne({ PostID: postId })) ??
    (await c.comments.findOne({ PostID: postId }));
  return hit as unknown as PostLike | null;
}

async function loadContext(c: Collections, trigger: PostLike): Promise<PostAiContext> {
  const thread: PostLike[] = [];
  let parentId = trigger.Type === 'comment' ? trigger.ParentId : undefined;
  while (parentId && thread.length < MAX_THREAD_DEPTH) {
    const parent = await findPost(c, parentId);
    if (!parent) break;
    thread.push(parent);
    parentId = parent.Type === 'comment' ? parent.ParentId : undefined;
  }

  const quoted = trigger.Type === 'quote' ? await findPost(c, trigger.OriginalPostId ?? '') : null;

  // For a comment, "replies" are its siblings under the same parent; for a post or quote, the
  // comments already on it (a brand-new one has none, which is fine).
  const replyParentId = trigger.Type === 'comment' ? trigger.ParentId : trigger.PostID;
  const siblings = replyParentId
    ? await c.comments
        .find({ ParentId: replyParentId, PostID: { $ne: trigger.PostID } })
        .sort({ TimeOfPost: -1 })
        .limit(MAX_SIBLING_COMMENTS)
        .toArray()
    : [];

  return { trigger, thread, quoted, replies: (siblings as unknown as PostLike[]).reverse() };
}

/** If a new post/comment/quote mentions `@ai`, posts the assistant's answer as a comment on it. */
export async function maybeReplyAsAiToPost(params: { redis: Redis; post: PostLike }): Promise<void> {
  const { redis, post } = params;
  if (!mentionsAi(post.Caption)) return;
  if (post.Type === 'repost' || post.WhoCanComment === 'none') return;

  const botId = process.env.AI_BOT_USER_ID;
  if (!botId || !ObjectId.isValid(botId)) {
    console.warn('[ai] AI_BOT_USER_ID is not set to a valid user id; ignoring @ai in post');
    return;
  }
  if (post.UserId === botId) return;

  const claimed = await redis.set(`ai:post-cooldown:${post.UserId}`, '1', 'EX', COOLDOWN_SECONDS, 'NX');
  if (!claimed) return;

  try {
    const db = await new MongoDBClient().init();
    const collections: Collections = { posts: db.posts(), shares: db.postsShares(), comments: db.postsComments() };
    const bot = await db.users().findOne({ _id: new ObjectId(botId) });
    if (!bot) {
      console.error(`[ai] Bot user ${botId} not found`);
      return;
    }

    const context = await loadContext(collections, post);
    const result = await openRouter.chat.completions.create({
      model: aiModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPostAiPrompt(context) },
      ],
      max_tokens: MAX_REPLY_TOKENS,
    });
    const text = result.choices[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty AI response');

    const now = new Date().toISOString();
    const reply = {
      _id: new ObjectId(),
      PostID: '',
      UserId: botId,
      ParentId: post.PostID,
      DisplayPicture: bot.displayPicture ?? '',
      NameOfPoster: bot.name || `${bot.firstname ?? ''} ${bot.lastname ?? ''}`.trim(),
      Verified: bot.verified ?? false,
      Username: bot.username ?? '',
      TimeOfPost: now,
      Visibility: 'everyone',
      WhoCanComment: 'everyone',
      Caption: text.slice(0, MAX_REPLY_CHARS),
      Image: [] as string[],
      Code: '',
      IsFollowing: false,
      NoOfLikes: 0,
      Liked: false,
      NoOfComment: 0,
      NoOfShares: 0,
      NoOfBookmarks: 0,
      Bookmarked: false,
      Shared: false,
      Type: 'comment' as const,
    };
    reply.PostID = reply._id.toString();

    // Count the comment on whichever collection holds the post (post, quote or comment).
    const parentCollection =
      (await collections.posts.findOne({ PostID: post.PostID }, { projection: { _id: 1 } }))
        ? collections.posts
        : (await collections.shares.findOne({ PostID: post.PostID }, { projection: { _id: 1 } }))
          ? collections.shares
          : collections.comments;
    await collections.comments.insertOne(reply as never);
    const updated = await parentCollection.findOneAndUpdate(
      { PostID: post.PostID },
      { $inc: { NoOfComment: 1 } },
      { returnDocument: 'after' }
    );

    // The bot is the author, so everyone (including the asker) gets the live update.
    await offlineMessageManager.broadcastMessage({ type: 'newComment', data: { blog: reply } }, botId);
    await offlineMessageManager.broadcastMessage(
      {
        type: 'updatePost',
        data: { postId: post.PostID, update: { NoOfComment: updated?.NoOfComment ?? 1 }, type: 'comment' },
      },
      botId
    );

    const actor = await loadActor(db, botId);
    if (actor) {
      await recordNotification(db, {
        recipientId: post.UserId,
        actorId: botId,
        actor,
        type: 'comment',
        targetType: post.Type === 'comment' ? 'comment' : 'post',
        targetId: post.PostID,
        sourceId: reply.PostID,
        url: contentUrl(post),
        snippet: reply.Caption,
      });
    }
  } catch (error) {
    console.error('[ai] Failed to reply to post:', error);
  }
}
