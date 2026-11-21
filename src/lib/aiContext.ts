const MAX_CONTEXT_CHARS = 2000;

const MAX_MEMBERS_LISTED = 40;
const MAX_BIO_CHARS = 120;

export type GroupFacts = {
  name?: string;
  description?: string;
  createdAt?: string;
  isPrivate?: boolean;
  memberCount: number;
  admins: string[];
  members: { name: string; username?: string; bio?: string }[];
  asker?: { name?: string; username?: string };
};

/** Describes the group so the model can answer questions about it. */
export function buildGroupContext(facts: GroupFacts): string {
  const lines: string[] = ['About this group chat:'];
  lines.push(`- Name: ${facts.name || '(unnamed)'}`);
  lines.push(`- Description: ${facts.description?.trim() || '(none set)'}`);
  if (facts.createdAt) lines.push(`- Created: ${facts.createdAt.slice(0, 10)}`);
  if (facts.isPrivate !== undefined) lines.push(`- Visibility: ${facts.isPrivate ? 'private' : 'public'}`);
  lines.push(`- Members (${facts.memberCount}): ${
    facts.members
      .slice(0, MAX_MEMBERS_LISTED)
      .map((m) => {
        const handle = m.username ? ` (@${m.username})` : '';
        const bio = m.bio?.trim() ? ` - ${m.bio.trim().slice(0, MAX_BIO_CHARS)}` : '';
        return `${m.name}${handle}${bio}`;
      })
      .join('; ') || 'unknown'
  }${facts.memberCount > MAX_MEMBERS_LISTED ? `; and ${facts.memberCount - MAX_MEMBERS_LISTED} more` : ''}`);
  if (facts.admins.length) lines.push(`- Admins: ${facts.admins.join(', ')}`);
  if (facts.asker?.name || facts.asker?.username) {
    lines.push(`- The person asking you right now: ${facts.asker.name || facts.asker.username}`);
  }
  return lines.join('\n');
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** Turns stored chat messages (oldest first) into model input; the bot's own messages become assistant turns. */
export function buildAiContext(
  messages: {
    _id?: unknown;
    content?: string;
    quotedMessageId?: string;
    sender?: { id?: string; name?: string; username?: string };
  }[],
  botId: string
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const byId = new Map(messages.map((m) => [String(m._id), m]));
  for (const message of messages) {
    let text = (message.content ?? '').trim().slice(0, MAX_CONTEXT_CHARS);
    if (!text) continue;
    const quoted = message.quotedMessageId ? byId.get(message.quotedMessageId) : undefined;
    if (quoted?.content) {
      const quotedWho = quoted.sender?.name || quoted.sender?.username || 'Someone';
      text = `(replying to ${quotedWho}: "${quoted.content.trim().slice(0, 200)}") ${text}`;
    }
    if (message.sender?.id === botId) {
      turns.push({ role: 'assistant', content: text });
    } else {
      const who = message.sender?.name || message.sender?.username || 'Someone';
      turns.push({ role: 'user', content: `${who}: ${text}` });
    }
  }
  return turns;
}
