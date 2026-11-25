import type { MessageType } from '../types.js';

/** Only these message types can be sent as view once. */
export const VIEW_ONCE_TYPES: MessageType[] = ['Image', 'Video', 'VoiceNote'];

/**
 * How long the link handed to a viewer works. A photo loads at once, so its link is short; a video
 * or voice note is streamed (and may be sought) while it plays, so its link has to last longer.
 */
export function viewOnceLinkSeconds(messageType: string | undefined): number {
  return messageType === 'Image' ? 60 : 300;
}
/** After the last recipient opens it, the file is deleted once every link has surely expired. */
export const VIEW_ONCE_GRACE_MS = 360_000;
/** A view once file nobody opened is deleted after this long. */
export const VIEW_ONCE_MAX_MS = 24 * 60 * 60 * 1000;

/** Why a view once request is invalid, or null when it is fine. Applied to what the client asks for. */
export function viewOnceRequestError(params: {
  attachmentCount: number;
  mimeTypes: string[];
}): string | null {
  if (params.attachmentCount !== 1) return 'View once works with exactly one photo, video or voice note';
  const mime = params.mimeTypes[0] ?? '';
  if (!/^(image|video|audio)\//.test(mime)) return 'Only photos, videos and voice notes can be sent as view once';
  return null;
}

/** Whether a given person may open a view once message right now. */
export function openViewOnceError(params: {
  viewOnce?: boolean;
  gone?: boolean;
  senderId: string;
  userId: string;
  isMember: boolean;
  opens?: Record<string, string>;
  hasFile: boolean;
}): string | null {
  if (!params.viewOnce) return 'This message is not view once';
  if (!params.isMember) return 'You are not a member of this chat';
  if (params.senderId === params.userId) return "You can't open your own view once message";
  if (params.opens?.[params.userId]) return 'You have already opened this';
  if (params.gone || !params.hasFile) return 'This is no longer available';
  return null;
}

/** True when every recipient (everyone but the sender) has opened it. */
export function everyoneOpened(params: { memberIds: string[]; senderId: string; opens: Record<string, string> }): boolean {
  const recipients = params.memberIds.filter((id) => id !== params.senderId);
  return recipients.length > 0 && recipients.every((id) => Boolean(params.opens[id]));
}

/** When the file should be deleted: soon after the last open, otherwise at the 24 hour limit. */
export function viewOnceDeleteAt(params: { sentAt: string | Date; allOpenedAt?: Date }): Date {
  if (params.allOpenedAt) return new Date(params.allOpenedAt.getTime() + VIEW_ONCE_GRACE_MS);
  return new Date(new Date(params.sentAt).getTime() + VIEW_ONCE_MAX_MS);
}

/** The label that stands in for the file in previews and pushes. */
export function viewOnceLabel(messageType: string | undefined): string {
  if (messageType === 'Video') return '🎥 View once video';
  if (messageType === 'VoiceNote') return '🎤 View once voice message';
  return '📷 View once photo';
}

/** The attachments a message payload may carry: none at all for view once, so no link ever leaves the server. */
export function payloadAttachments<T>(viewOnce: boolean | undefined, attachments: T[]): T[] {
  return viewOnce ? [] : attachments;
}
