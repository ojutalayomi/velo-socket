import type { MessageType } from '../types.js';

/**
 * The one rule for what kind of message something is. Mirrors velo's lib/messageType.ts, and is
 * authoritative here: the type a client claims never decides, only the content and attachments.
 */

/** Types whose content is validated separately; a request for one of these is kept as asked. */
const STRUCTURED: ReadonlySet<string> = new Set([
  'Poll',
  'Call',
  'Location',
  'Contact',
  'Sticker',
  'AnimatedGIF',
  'Announcement',
]);

const URL_ONLY = /^https?:\/\/[^\s"]+$/i;
const VOICE_NOTE_NAME = /(^|\/)voice-note-\d+-\d+s\./;

export const isUrlOnly = (content: string) => URL_ONLY.test(content.trim());
export const isVoiceNoteName = (name: string | undefined) => VOICE_NOTE_NAME.test(name ?? '');

export interface TypeInput {
  content?: string;
  attachments?: { type?: string; name?: string; key?: string }[];
  requested?: string;
}

function attachmentKind(type: string | undefined): 'image' | 'video' | 'audio' | 'file' {
  const major = (type ?? '').split('/')[0];
  return major === 'image' || major === 'video' || major === 'audio' ? major : 'file';
}

export function deriveMessageType({ content = '', attachments = [], requested }: TypeInput): MessageType {
  if (requested && STRUCTURED.has(requested)) return requested as MessageType;

  const text = content.trim();
  if (attachments.length > 0) {
    if (text) return requested === 'Markdown' ? 'Markdown' : 'Text';
    const kinds = new Set(attachments.map((a) => attachmentKind(a.type)));
    if (kinds.size > 1) return 'File';
    const kind = [...kinds][0];
    if (kind === 'audio' && attachments.length === 1 && isVoiceNoteName(attachments[0].name ?? attachments[0].key)) {
      return 'VoiceNote';
    }
    return kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'File';
  }

  if (isUrlOnly(text)) return 'Link';
  return requested === 'Markdown' ? 'Markdown' : 'Text';
}
