import assert from 'node:assert/strict';
import test from 'node:test';

import { sweepScheduledPosts } from '../../lib/scheduledPosts.js';
import { CLAIM_TIMEOUT_MS, pollOutlivesSchedule, validateScheduledFor } from '../../lib/scheduling.js';

const now = new Date('2026-11-28T10:00:00.000Z');
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

test('a schedule must be between a minute and a year away', () => {
  assert.deepEqual(validateScheduledFor(at(2 * 60_000), now), { ok: true, iso: at(2 * 60_000) });
  assert.equal(validateScheduledFor(at(30_000), now).ok, false);
  assert.equal(validateScheduledFor(at(-60_000), now).ok, false);
  assert.equal(validateScheduledFor(at(366 * 24 * 60 * 60 * 1000), now).ok, false);
  assert.equal(validateScheduledFor('soon', now).ok, false);
  assert.equal(validateScheduledFor(undefined, now).ok, false);
  assert.equal(validateScheduledFor(12345, now).ok, false);
});

test('a poll must still be open when the post goes live', () => {
  assert.equal(pollOutlivesSchedule(undefined, at(120_000)), true);
  assert.equal(pollOutlivesSchedule({}, at(120_000)), true);
  assert.equal(pollOutlivesSchedule({ expiresAt: at(60_000) }, at(120_000)), false);
  assert.equal(pollOutlivesSchedule({ expiresAt: at(600_000) }, at(120_000)), true);
});

type Doc = { _id: string; scheduledFor?: string; publishing?: string; TimeOfPost: string; Caption: string };

function fakePosts(docs: Doc[]) {
  const dueNow = (d: Doc) => {
    const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
    return !!d.scheduledFor && d.scheduledFor <= now.toISOString() && (!d.publishing || d.publishing < stale);
  };
  return {
    docs,
    findOneAndUpdate: async (_filter: unknown, update: { $set: { publishing: string } }) => {
      const doc = docs.find(dueNow);
      if (!doc) return null;
      doc.publishing = update.$set.publishing;
      return { ...doc };
    },
    updateOne: async (filter: { _id: string }, update: { $set: Record<string, string>; $unset: Record<string, string> }) => {
      const doc = docs.find((d) => d._id === filter._id)!;
      Object.assign(doc, update.$set);
      for (const key of Object.keys(update.$unset)) delete (doc as Record<string, unknown>)[key];
      return {};
    },
  };
}

test('the sweep publishes what is due, once, and leaves the rest', async () => {
  const posts = fakePosts([
    { _id: 'due', scheduledFor: at(-1000), TimeOfPost: at(-1000), Caption: 'a' },
    { _id: 'later', scheduledFor: at(60_000), TimeOfPost: at(60_000), Caption: 'b' },
    { _id: 'live', TimeOfPost: at(-5000), Caption: 'c' },
  ]);
  const announced: Record<string, unknown>[] = [];
  const count = await sweepScheduledPosts(posts as never, async (doc) => void announced.push(doc), now);
  assert.equal(count, 1);
  assert.equal(announced.length, 1);
  assert.equal(announced[0]._id, 'due');
  assert.equal(announced[0].scheduledFor, undefined);
  assert.equal(announced[0].TimeOfPost, now.toISOString());
  // Live and visible now, with the time it actually went live.
  assert.equal(posts.docs[0].scheduledFor, undefined);
  assert.equal(posts.docs[0].TimeOfPost, now.toISOString());
  assert.equal(posts.docs[1].scheduledFor, at(60_000));
  // A second run finds nothing more to do.
  assert.equal(await sweepScheduledPosts(posts as never, async () => assert.fail('published twice'), now), 0);
});

test('a post claimed by another server is not published twice, but a stuck claim is retried', async () => {
  const fresh = fakePosts([{ _id: 'a', scheduledFor: at(-1000), publishing: at(-1000), TimeOfPost: '', Caption: '' }]);
  assert.equal(await sweepScheduledPosts(fresh as never, async () => assert.fail('double publish'), now), 0);

  const stuck = fakePosts([{ _id: 'b', scheduledFor: at(-1000), publishing: at(-CLAIM_TIMEOUT_MS - 1000), TimeOfPost: '', Caption: '' }]);
  assert.equal(await sweepScheduledPosts(stuck as never, async () => {}, now), 1);
});

test('one failing announcement does not stop the others', async () => {
  const posts = fakePosts([
    { _id: 'x', scheduledFor: at(-2000), TimeOfPost: '', Caption: '' },
    { _id: 'y', scheduledFor: at(-1000), TimeOfPost: '', Caption: '' },
  ]);
  const seen: unknown[] = [];
  const original = console.error;
  console.error = () => {};
  try {
    const count = await sweepScheduledPosts(posts as never, async (doc) => {
      seen.push(doc._id);
      if (doc._id === 'x') throw new Error('push failed');
    }, now);
    assert.equal(count, 2);
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ['x', 'y']);
});
