import { callPreview, parseCallRecord } from './callRecord.js';

/** Validation for the optional poll / location attached to a post (mirrors velo's lib/polls.ts). */
export type PollData = { question: string; options: string[]; multiple: boolean; expiresAt?: string };
export type PostLocation = { name: string; lat?: number; lng?: number };
export type PostGifData = { provider: 'klipy'; kind: 'gifs' | 'stickers'; slug: string; url: string; title?: string; width?: number; height?: number };

const MAX_QUESTION = 200;
const MAX_OPTION = 80;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_LOCATION_NAME = 120;

export function sanitizePoll(input: unknown): PollData | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<PollData>;
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question || question.length > MAX_QUESTION || !Array.isArray(raw.options)) return null;

  const options: string[] = [];
  for (const option of raw.options) {
    if (typeof option !== 'string') return null;
    const text = option.trim();
    if (!text) continue;
    if (text.length > MAX_OPTION) return null;
    if (!options.some((o) => o.toLowerCase() === text.toLowerCase())) options.push(text);
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;

  const poll: PollData = { question, options, multiple: raw.multiple === true };
  if (typeof raw.expiresAt === 'string' && !Number.isNaN(Date.parse(raw.expiresAt))) {
    poll.expiresAt = new Date(raw.expiresAt).toISOString();
  }
  return poll;
}

const MAX_GIF_URL = 500;
const MAX_GIF_TITLE = 200;

/** A KLIPY GIF or sticker attached to a post: only a KLIPY link is kept, with sizes bounded. */
export function sanitizeGif(input: unknown): PostGifData | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<PostGifData>;
  if (raw.provider !== 'klipy' || (raw.kind !== 'gifs' && raw.kind !== 'stickers')) return null;
  if (typeof raw.slug !== 'string' || !raw.slug || raw.slug.length > 200) return null;
  if (typeof raw.url !== 'string' || raw.url.length > MAX_GIF_URL || !isKlipyUrl(raw.url)) return null;
  const gif: PostGifData = { provider: 'klipy', kind: raw.kind, slug: raw.slug, url: raw.url };
  if (typeof raw.title === 'string' && raw.title.trim()) gif.title = raw.title.trim().slice(0, MAX_GIF_TITLE);
  for (const key of ['width', 'height'] as const) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 4000) gif[key] = Math.round(value);
  }
  return gif;
}

export function sanitizeLocation(input: unknown): PostLocation | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<PostLocation>;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_LOCATION_NAME) : '';
  if (!name) return null;
  const location: PostLocation = { name };
  if (
    typeof raw.lat === 'number' && typeof raw.lng === 'number' &&
    Math.abs(raw.lat) <= 90 && Math.abs(raw.lng) <= 180
  ) {
    location.lat = raw.lat;
    location.lng = raw.lng;
  }
  return location;
}

/** Validates a location message's JSON content; returns the canonical JSON, or null if invalid. */
export function canonicalLocationContent(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  try {
    const location = sanitizeLocation(JSON.parse(content));
    return location ? JSON.stringify(location) : null;
  } catch {
    return null;
  }
}

/** KLIPY media is shown straight from its own hosts; anything else is not accepted as a GIF or sticker. */
const KLIPY_URL = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i;
export const isKlipyUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 2000 && KLIPY_URL.test(value);

/**
 * Validates a GIF / sticker message's JSON content. URLs are kept exactly as KLIPY returned them
 * (its terms forbid rewriting them); only the shape and the host are checked.
 */
export function canonicalKlipyContent(content: unknown): string | null {
  if (typeof content !== 'string' || content.length > 6000) return null;
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (!isKlipyUrl(raw.url)) return null;
    if (raw.previewUrl !== undefined && !isKlipyUrl(raw.previewUrl)) return null;
    const dimension = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 4000 ? Math.round(value) : undefined;
    return JSON.stringify({
      provider: 'klipy',
      slug: typeof raw.slug === 'string' ? raw.slug.slice(0, 200) : '',
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
      url: raw.url,
      ...(raw.previewUrl ? { previewUrl: raw.previewUrl } : {}),
      width: dimension(raw.width),
      height: dimension(raw.height),
    });
  } catch {
    return null;
  }
}

/** A shared Velo user. Only the id is taken from the sender; the rest is read from the account. */
export type ContactData = { userId: string; name: string; username: string; displayPicture: string; verified: boolean };

export function requestedContactId(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  try {
    const id = (JSON.parse(content) as { userId?: unknown })?.userId;
    return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function contactContent(user: {
  _id: { toString(): string };
  name?: string;
  firstname?: string;
  lastname?: string;
  username?: string;
  displayPicture?: string;
  verified?: boolean;
}): string {
  const data: ContactData = {
    userId: user._id.toString(),
    name: user.name || [user.firstname, user.lastname].filter(Boolean).join(' ').trim() || user.username || 'Velo user',
    username: user.username ?? '',
    displayPicture: user.displayPicture ?? '',
    verified: Boolean(user.verified),
  };
  return JSON.stringify(data);
}

/** Validates a poll message's JSON content; returns the canonical JSON, or null if invalid. */
export function canonicalPollContent(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  try {
    const poll = sanitizePoll(JSON.parse(content));
    return poll ? JSON.stringify(poll) : null;
  } catch {
    return null;
  }
}

const ATTACHMENT_LABELS: Record<string, string> = {
  Image: '📷 Photo',
  Video: '🎥 Video',
  Audio: '🎵 Audio',
  VoiceNote: '🎤 Voice message',
  File: '📄 File',
};

/** Readable text for notifications/AI: poll messages store JSON, which should not be shown raw. */
export function messageDisplayText(messageType: string | undefined, content: string | undefined): string {
  if (messageType === 'Poll') {
    try {
      const poll = sanitizePoll(JSON.parse(content ?? ''));
      if (poll) return `📊 ${poll.question}`;
    } catch {
      /* fall through to raw content */
    }
  }
  if (!(content ?? '').trim()) {
    const label = ATTACHMENT_LABELS[messageType ?? ''];
    if (label) return label;
  }
  if (messageType === 'AnimatedGIF') return '🎞 GIF';
  if (messageType === 'Sticker') return '🏷 Sticker';
  if (messageType === 'Location') {
    try {
      const location = sanitizeLocation(JSON.parse(content ?? ''));
      if (location) return `📍 ${location.name}`;
    } catch {
      /* fall through */
    }
  }
  if (messageType === 'Contact') {
    try {
      const name = (JSON.parse(content ?? '') as { name?: unknown })?.name;
      if (typeof name === 'string' && name) return `👤 ${name}`;
    } catch {
      /* fall through */
    }
  }
  if (messageType === 'Call') {
    const record = parseCallRecord(content);
    if (record) return callPreview(record);
  }
  return content ?? '';
}
