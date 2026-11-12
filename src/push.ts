import { config } from 'dotenv';
config();

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
}

const PUSH_ENDPOINT = '/api/push/send';
const REQUEST_TIMEOUT_MS = 8_000;

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

export function messagePreview(content?: string, attachmentCount = 0): string {
  const trimmed = (content ?? '').trim();

  if (trimmed) {
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }

  return attachmentCount > 0 ? 'Sent an attachment' : 'New message';
}
