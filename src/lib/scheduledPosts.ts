import type { Collection, Document } from 'mongodb';

import { CLAIM_TIMEOUT_MS } from './scheduling.js';

type PostsLike = Pick<Collection<Document>, 'findOneAndUpdate' | 'updateOne'>;

/**
 * Publishes the posts whose time has come. A post is claimed first (so a second server can't also
 * publish it), made visible, and only then announced.
 *
 * @returns how many posts were published
 */
export async function sweepScheduledPosts(
  posts: PostsLike,
  publish: (post: Document) => Promise<void>,
  now = new Date(),
  max = 50
): Promise<number> {
  const nowIso = now.toISOString();
  const staleClaim = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
  let published = 0;

  for (let i = 0; i < max; i++) {
    const claimed = await posts.findOneAndUpdate(
      {
        scheduledFor: { $lte: nowIso },
        $or: [{ publishing: { $exists: false } }, { publishing: { $lt: staleClaim } }],
      },
      { $set: { publishing: nowIso } },
      { returnDocument: 'after' }
    );
    if (!claimed) break;

    // Goes live now: the feed orders by TimeOfPost, so it must be the moment of publishing.
    await posts.updateOne(
      { _id: claimed._id },
      { $set: { TimeOfPost: nowIso }, $unset: { scheduledFor: '', publishing: '' } }
    );
    const { scheduledFor: _scheduledFor, publishing: _publishing, ...live } = claimed;
    void _scheduledFor;
    void _publishing;
    try {
      await publish({ ...live, TimeOfPost: nowIso });
    } catch (error) {
      console.error('scheduled post: announcing failed', error);
    }
    published++;
  }
  return published;
}

/** Looks for due posts every 30 seconds. Posts that came due while the server was down go out on the first run. */
export function startScheduledPostSweep(run: () => Promise<unknown>) {
  const timer = setInterval(() => {
    run().catch((error) => console.error('scheduled post sweep failed:', error));
  }, 30_000);
  timer.unref?.();
  // Don't wait half a minute after a restart.
  run().catch((error) => console.error('scheduled post sweep failed:', error));
  return timer;
}
