/**
 * Group-wide mention triggers: `@all` pings every member (admins only) and `@ai` asks the
 * AI assistant to reply. Both are detected from the message text on the server; the client's
 * mention list is never trusted for them.
 */

/** Marker stored in `message.mentions` so clients can highlight an accepted `@all`. */
export const EVERYONE_MENTION = { userId: 'all', username: 'all' } as const;

// Must start the message or follow whitespace (so emails and "foo@all" never match) and end
// on a word boundary (so "@allison" and "@aim" never match).
const EVERYONE_PATTERN = /(?:^|\s)@all\b/i;
const AI_PATTERN = /(?:^|\s)@ai\b/i;

export function mentionsEveryone(content?: string | null): boolean {
  return Boolean(content) && EVERYONE_PATTERN.test(content as string);
}

export function mentionsAi(content?: string | null): boolean {
  return Boolean(content) && AI_PATTERN.test(content as string);
}

/** `@all` only works in groups, and only for the group's admins. */
export function canMentionEveryone(params: {
  chatType?: string;
  adminIds?: string[];
  senderId: string;
}): boolean {
  return params.chatType === 'Group' && Boolean(params.adminIds?.includes(params.senderId));
}

/** Members an accepted `@all` should notify: everyone except the sender and muted members. */
export function everyoneRecipients(
  participants: { userId: string; chatSettings?: { isMuted?: boolean } | null }[],
  senderId: string
): string[] {
  const ids = new Set<string>();
  for (const participant of participants) {
    if (!participant.userId || participant.userId === senderId) continue;
    if (participant.chatSettings?.isMuted) continue;
    ids.add(participant.userId);
  }
  return Array.from(ids);
}

/**
 * Mentions to store on a message: whatever the client sent, minus any `all` marker it forged,
 * plus the marker when the server accepted the `@all`.
 */
export function sanitizeMentions(
  mentions: { userId: string; username: string }[] | undefined,
  everyoneAllowed: boolean
): { userId: string; username: string }[] {
  const explicit = (mentions ?? []).filter(
    (mention) => mention.userId !== EVERYONE_MENTION.userId && mention.username?.toLowerCase() !== 'all'
  );
  return everyoneAllowed ? [...explicit, { ...EVERYONE_MENTION }] : explicit;
}
