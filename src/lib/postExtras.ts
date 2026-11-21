/** Validation for the optional poll / location attached to a post (mirrors velo's lib/polls.ts). */
export type PollData = { question: string; options: string[]; multiple: boolean; expiresAt?: string };
export type PostLocation = { name: string; lat?: number; lng?: number };

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
