/** Reading a chat-completion response. Pure, so it can be tested without any connections. */

export interface ReplyReading {
  text: string;
  /** Why the model stopped: "stop", "length" (ran out of tokens), "content_filter", ... */
  finishReason?: string;
  /** Set when the response carried a refusal or an error instead of text. */
  problem?: string;
}

export function readReply(response: unknown): ReplyReading {
  const body = (response ?? {}) as {
    error?: { message?: string; code?: unknown };
    choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: string } }[];
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  const text = Array.isArray(content)
    ? content
        .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
        .join('\n')
        .trim()
    : typeof content === 'string'
      ? content.trim()
      : '';

  let problem: string | undefined;
  if (body.error) problem = `provider error: ${body.error.message ?? JSON.stringify(body.error.code)}`;
  else if (!choice) problem = 'no choices returned';
  else if (choice.message?.refusal) problem = `refusal: ${choice.message.refusal}`;

  return { text, finishReason: choice?.finish_reason, problem };
}

/** Whether a second attempt might help, and with how many tokens. */
export function nextAttempt(reading: ReplyReading, tokens: number): { retry: boolean; tokens: number } {
  if (reading.problem?.startsWith('refusal') || reading.finishReason === 'content_filter') {
    return { retry: false, tokens };
  }
  // Reasoning models spend the budget thinking, leaving no room for the answer.
  if (reading.finishReason === 'length') return { retry: true, tokens: tokens * 3 };
  return { retry: true, tokens };
}
