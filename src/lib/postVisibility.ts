/*
 * Who can see a post, and who can reply to it. One control in the composer sets both:
 *   everyone: anyone sees it and anyone replies
 *   friends:  mutual follows (and the author) see it and reply
 *   me:       only the author sees it; nobody else replies
 *
 * Old posts were saved with the reply setting in the visibility field, so "none" means "visible to
 * everyone, replies off" there. It stays public, and its WhoCanComment still decides who replies.
 *
 * The socket server has a copy of this file (velo-socket/src/lib/postVisibility.ts): keep them in step.
 */
export type PostVisibility = "everyone" | "friends" | "me";
export type ReplyPolicy = "everyone" | "friends" | "none";

export const POST_VISIBILITIES: readonly PostVisibility[] = ["everyone", "friends", "me"];

type Audience = { Visibility?: unknown; WhoCanComment?: unknown; UserId?: unknown };

/** How a saved post is shown. Missing and unknown values stay public, as they always were. */
export function normalizeVisibility(value: unknown): PostVisibility {
  return value === "friends" || value === "me" ? value : "everyone";
}

/** Reads what a client sent when creating a post, including the old single-dropdown values. */
export function resolveAudience(input: Audience): { Visibility: PostVisibility; WhoCanComment: ReplyPolicy } {
  if (input.Visibility === "me") return { Visibility: "me", WhoCanComment: "none" };
  if (input.Visibility === "friends") return { Visibility: "friends", WhoCanComment: "friends" };
  // An old client's "none" meant replies off on a public post.
  if (input.Visibility === "none") return { Visibility: "everyone", WhoCanComment: "none" };
  return { Visibility: "everyone", WhoCanComment: "everyone" };
}

/** Who may reply. The author always may. */
export function replyPolicy(post: Audience): ReplyPolicy {
  const visibility = normalizeVisibility(post.Visibility);
  if (visibility === "me" || post.Visibility === "none") return "none";
  if (visibility === "friends") return "friends";
  return post.WhoCanComment === "none" || post.WhoCanComment === "friends" ? post.WhoCanComment : "everyone";
}

function isAuthor(post: Audience, viewerId?: string) {
  return !!viewerId && typeof post.UserId === "string" && post.UserId === viewerId;
}

export function canViewPost(post: Audience, viewerId: string | undefined, isMutual: boolean): boolean {
  const visibility = normalizeVisibility(post.Visibility);
  if (visibility === "everyone") return true;
  if (isAuthor(post, viewerId)) return true;
  return visibility === "friends" && isMutual;
}

export function canReplyToPost(post: Audience, viewerId: string | undefined, isMutual: boolean): boolean {
  if (!viewerId) return false;
  if (!canViewPost(post, viewerId, isMutual)) return false;
  if (isAuthor(post, viewerId)) return true;
  const policy = replyPolicy(post);
  return policy === "everyone" || (policy === "friends" && isMutual);
}

/** Posts waiting for their publish time carry `scheduledFor`; nobody but the author's list sees them. */
export const PUBLISHED = { scheduledFor: { $exists: false } } as const;

function at(prefix: string, field: string) {
  return prefix ? `${prefix}.${field}` : field;
}

/**
 * Mongo clause for "posts this viewer may see". `mutualIds` are the accounts that follow the viewer
 * and are followed back. A signed-out viewer sees public posts only.
 */
export function visibleToFilter(viewerId: string | undefined, mutualIds: string[], prefix = "") {
  const visibility = at(prefix, "Visibility");
  const userId = at(prefix, "UserId");
  const or: Record<string, unknown>[] = [{ [visibility]: { $nin: ["friends", "me"] } }];
  if (viewerId) {
    or.push({ [userId]: viewerId });
    if (mutualIds.length > 0) or.push({ [visibility]: "friends", [userId]: { $in: mutualIds } });
  }
  return { $or: or };
}

/** Published and visible to the viewer: one clause to add to any list of posts. */
export function readableFilter(viewerId: string | undefined, mutualIds: string[], prefix = "") {
  return { $and: [{ [at(prefix, "scheduledFor")]: { $exists: false } }, visibleToFilter(viewerId, mutualIds, prefix)] };
}
