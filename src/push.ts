import { config } from 'dotenv';
config();

import type Redis from 'ioredis';
import { claimBatch, type DedupKind } from './notifications/dedup.js';
import { filterOfflineUsers } from './presence.js';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  action?: 'close';
}

export interface DeliverPushOptions {
  kind: DedupKind;
  sourceId?: string;
  userIds: string[];
  payload: PushPayload;
  /** Skip recipients with a live socket connection (checked again at delivery time). */
  requireOffline?: boolean;
  redis?: Redis;
}

const PUSH_ENDPOINT = '/api/push/send';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RECIPIENTS_PER_REQUEST = 500;

function resolvePushServiceUrl(): string {
  const raw = process.env.PUSH_SERVICE_URL || process.env.NEXTAUTH_URL || '';

  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

/** Fire-and-forget push delivery through the web app's internal push API. */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  const secret = process.env.PUSH_INTERNAL_SECRET;
  const serviceUrl = resolvePushServiceUrl();
  const recipients = Array.from(
    new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))
  );

  if (recipients.length === 0 || !secret || !serviceUrl) return;

  try {
    const response = await fetch(`${serviceUrl}${PUSH_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-push-secret': secret,
      },
      body: JSON.stringify({ userIds: recipients, payload }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[push] Delivery request failed with status ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[push] Delivery request failed:', message);
  }
}

/**
 * Re-checks presence, claims dedup slots, then delivers in ≤500-recipient chunks.
 */
export async function deliverPush(options: DeliverPushOptions): Promise<void> {
  let recipients = Array.from(
    new Set(options.userIds.filter((id) => typeof id === 'string' && id.length > 0))
  );
  if (recipients.length === 0) return;

  if (options.requireOffline && options.redis) {
    recipients = await filterOfflineUsers(options.redis, recipients);
  }
  if (options.redis && options.sourceId) {
    recipients = await claimBatch(options.redis, options.kind, recipients, options.sourceId);
  }
  if (recipients.length === 0) return;

  for (let index = 0; index < recipients.length; index += MAX_RECIPIENTS_PER_REQUEST) {
    await sendPushToUsers(recipients.slice(index, index + MAX_RECIPIENTS_PER_REQUEST), options.payload);
  }
}

/** Dismisses existing notifications by tag. Delivered even to online users. */
export async function sendSilentClose(userIds: string[], tag?: string): Promise<void> {
  if (!tag) return;

  await sendPushToUsers(userIds, {
    title: '',
    body: '',
    action: 'close',
    tag,
  });
}

export function messagePreview(content?: string, attachmentCount = 0): string {
  const trimmed = (content ?? '').trim();

  if (trimmed) {
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }

  return attachmentCount > 0 ? 'Sent an attachment' : 'New message';
}
