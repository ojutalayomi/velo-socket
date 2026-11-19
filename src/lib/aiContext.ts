const MAX_CONTEXT_CHARS = 2000;

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** Turns stored chat messages (oldest first) into model input; the bot's own messages become assistant turns. */
export function buildAiContext(
  messages: { content?: string; sender?: { id?: string; name?: string; username?: string } }[],
  botId: string
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const text = (message.content ?? '').trim().slice(0, MAX_CONTEXT_CHARS);
    if (!text) continue;
    if (message.sender?.id === botId) {
      turns.push({ role: 'assistant', content: text });
    } else {
      const who = message.sender?.name || message.sender?.username || 'Someone';
      turns.push({ role: 'user', content: `${who}: ${text}` });
    }
  }
  return turns;
}
