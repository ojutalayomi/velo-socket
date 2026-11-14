export function contentUrl(content: unknown): string {
  const record = (content ?? {}) as { Username?: unknown; PostID?: unknown };
  const username = typeof record.Username === 'string' ? record.Username : '';
  const postId = typeof record.PostID === 'string' ? record.PostID : '';

  if (!username || !postId) return '/notifications';

  return `/${encodeURIComponent(username)}/posts/${encodeURIComponent(postId)}`;
}

export function profileUrl(username?: string | null): string {
  if (!username) return '/notifications';
  return `/${encodeURIComponent(username)}`;
}

export function chatUrl(chatId?: string | null, chatType?: string | null): string {
  if (!chatId) return '/chats';
  return chatType === 'Group' || chatType === 'Channels'
    ? `/chats/group/${encodeURIComponent(chatId)}`
    : `/chats/${encodeURIComponent(chatId)}`;
}
