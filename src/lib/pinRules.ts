/** The most messages that can be pinned in one chat. Mirrored in the web app (lib/pinRules.ts). */
export const MAX_PINNED_MESSAGES = 5;

export interface PinnedMessage {
  messageId: string;
  pinnedBy: string;
  pinnedAt: string;
}

/**
 * Who may pin and unpin. In a DM either person can; in a group or channel only its admins,
 * the same people who can change its other shared settings.
 */
export function canPinMessages(params: {
  chatType?: string;
  adminIds?: string[];
  userId: string;
}): boolean {
  if (params.chatType === 'Group' || params.chatType === 'Channels') {
    return Boolean(params.adminIds?.includes(params.userId));
  }
  return true;
}

export type PinPlan = { ok: true; pins: PinnedMessage[]; changed: boolean } | { ok: false; error: string };

/** Adds a pin, newest first. Pinning what is already pinned changes nothing. */
export function planPin(
  pins: PinnedMessage[] | undefined,
  messageId: string,
  userId: string,
  now = new Date()
): PinPlan {
  const current = pins ?? [];
  if (current.some((pin) => pin.messageId === messageId)) return { ok: true, pins: current, changed: false };
  if (current.length >= MAX_PINNED_MESSAGES) {
    return { ok: false, error: `You can pin up to ${MAX_PINNED_MESSAGES} messages. Unpin one first.` };
  }
  return {
    ok: true,
    pins: [{ messageId, pinnedBy: userId, pinnedAt: now.toISOString() }, ...current],
    changed: true,
  };
}

/** Removes a pin. Unpinning what isn't pinned changes nothing. */
export function planUnpin(pins: PinnedMessage[] | undefined, messageId: string) {
  const current = pins ?? [];
  const next = current.filter((pin) => pin.messageId !== messageId);
  return { pins: next, changed: next.length !== current.length };
}
