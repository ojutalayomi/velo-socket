const MAX_CAPTION_CHARS = 1000;

export interface PostLike {
  PostID: string;
  UserId: string;
  Username?: string;
  NameOfPoster?: string;
  Caption?: string;
  Image?: string[];
  Type: 'post' | 'comment' | 'repost' | 'quote';
  ParentId?: string;
  OriginalPostId?: string;
  WhoCanComment?: string;
  Poll?: { question: string; options: string[] };
  Location?: { name: string };
}

export interface PostAiContext {
  trigger: PostLike;
  /** Ancestors of a comment, nearest first. */
  thread: PostLike[];
  /** The post being quoted. */
  quoted?: PostLike | null;
  /** Other replies under the same parent, oldest first. */
  replies: PostLike[];
}

const clip = (text: string | undefined, max = MAX_CAPTION_CHARS) => (text ?? '').trim().slice(0, max);
const who = (post: PostLike) => post.NameOfPoster || post.Username || 'Someone';

function describe(post: PostLike): string {
  const parts = [clip(post.Caption) || '(no text)'];
  if (post.Poll) parts.push(`[poll: "${post.Poll.question}" with options ${post.Poll.options.join(' / ')}]`);
  if (post.Location?.name) parts.push(`[location: ${post.Location.name}]`);
  if (post.Image?.length) parts.push(`[${post.Image.length} attached media file(s), not visible to you]`);
  return parts.join(' ');
}

/** Turns a post and its surroundings into the user message sent to the model. */
export function buildPostAiPrompt(context: PostAiContext): string {
  const { trigger, thread, quoted, replies } = context;
  const lines: string[] = [];

  if (thread.length) {
    lines.push('Conversation so far (oldest first):');
    for (const ancestor of [...thread].reverse()) lines.push(`- ${who(ancestor)}: ${describe(ancestor)}`);
  }
  if (quoted) {
    lines.push(`The ${trigger.Type} quotes this post by ${who(quoted)}: ${describe(quoted)}`);
  }
  if (replies.length) {
    lines.push('Other replies already posted:');
    for (const reply of replies) lines.push(`- ${who(reply)}: ${describe(reply)}`);
  }

  const kind = trigger.Type === 'comment' ? 'comment' : trigger.Type === 'quote' ? 'quote' : 'post';
  lines.push(`New ${kind} from ${who(trigger)}${trigger.Username ? ` (@${trigger.Username})` : ''}, addressed to you:`);
  lines.push(describe(trigger));
  return lines.join('\n');
}

