import OpenAI from 'openai';

export const openRouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
    ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
  },
});

/** Optional second model, tried when the first returns nothing (e.g. a rate-limited free model). */
export const aiFallbackModel = (): string | undefined => process.env.OPENROUTER_FALLBACK_MODEL || undefined;

export const aiModel = (): string =>
  process.env.OPENROUTER_MODEL || process.env.GEMINI_MODEL || 'openai/gpt-4o-mini';
