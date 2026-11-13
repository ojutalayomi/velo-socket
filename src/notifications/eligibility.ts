import type { NotificationPreferences } from '../types.js';
import { isWithinQuietHours } from './settings.js';

export type NotificationKind = 'message' | 'mention' | 'follow' | 'call';

export interface SelectRecipientsParams {
  candidates: string[];
  senderId: string;
  kind: NotificationKind;
  /** Users that belong to the conversation/relationship being notified. */
  participants: Set<string>;
  /** Recipients who blocked the sender. */
  blocked: Set<string>;
  preferences: Map<string, NotificationPreferences>;
  /** Recipients who muted the conversation (messages only). */
  muted: Set<string>;
  /** Recipients currently connected. */
  online: Set<string>;
  requireOffline: boolean;
  now?: Date;
}

function settingFor(kind: NotificationKind, preferences: NotificationPreferences): boolean {
  switch (kind) {
    case 'message':
      return preferences.messages;
    case 'mention':
      return preferences.mentions;
    case 'follow':
      return preferences.follows;
    case 'call':
      return preferences.calls;
  }
}

/**
 * Applies the delivery precedence:
 * sender -> participant -> block -> per-type setting -> offline -> mute -> quiet hours.
 * Calls bypass quiet hours.
 */
export function selectRecipients(params: SelectRecipientsParams): string[] {
  const now = params.now ?? new Date();
  const recipients: string[] = [];

  for (const userId of Array.from(new Set(params.candidates.filter(Boolean)))) {
    if (userId === params.senderId) continue;
    if (!params.participants.has(userId)) continue;
    if (params.blocked.has(userId)) continue;

    const preferences = params.preferences.get(userId);
    if (!preferences) continue;
    if (!settingFor(params.kind, preferences)) continue;

    if (params.requireOffline && params.online.has(userId)) continue;
    if (params.kind === 'message' && params.muted.has(userId)) continue;
    if (params.kind !== 'call' && isWithinQuietHours(now, preferences.dnd)) continue;

    recipients.push(userId);
  }

  return recipients;
}
