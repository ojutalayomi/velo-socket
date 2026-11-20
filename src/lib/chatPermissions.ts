/** Whether `userId` may post in a chat. Groups can be restricted to admins only. */
export function canSendMessage(params: {
  chatType?: string;
  onlyAdminsCanSend?: boolean;
  adminIds?: string[];
  userId: string;
}): boolean {
  if (params.chatType !== 'Group' || !params.onlyAdminsCanSend) return true;
  return Boolean(params.adminIds?.includes(params.userId));
}
