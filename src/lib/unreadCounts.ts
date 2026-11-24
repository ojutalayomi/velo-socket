/**
 * How much a new message raises a participant's unread count: by one for everyone except the
 * person who wrote it. Your own message is never unread for you. (Counting it for the sender
 * left a badge on the sender's chat list after a reload, because the sender's page only resets
 * the count while that chat is open, and that reset can arrive before this increment.)
 */
export function unreadIncrement(participantId: string, senderId: string | undefined): 0 | 1 {
  return senderId !== undefined && String(participantId) === String(senderId) ? 0 : 1;
}
