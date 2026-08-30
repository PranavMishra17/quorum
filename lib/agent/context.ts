import { CONTEXT } from '@/config';
import type { Message } from '@/lib/db/types';
import type { ProviderMessage } from '@/lib/llm/provider';

/**
 * Prompt assembly within a token budget.
 *
 * The budget is deliberately far below the model's 1M window: cost and
 * precision degrade long before the window does, and a prompt that includes
 * everything is not the same as a prompt that includes the right things.
 */

/**
 * Rough token estimate — ~4 characters per token.
 *
 * Deliberately approximate. The exact count needs `messages.count_tokens`,
 * which is a network round trip per turn to decide something a 20% margin
 * already answers. The budget is a soft ceiling with headroom, not a hard
 * limit, so an estimate is the right tool. If trimming ever becomes visible to
 * users, the fix is to measure, not to guess harder.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface AssembledContext {
  system: string;
  messages: ProviderMessage[];
  /** What was dropped, for the `context_dropped` event. Empty when nothing was. */
  dropped: string[];
  estimatedTokens: number;
}

export interface AssembleParams {
  chatName: string | null;
  chatType: string;
  memberNames: string[];
  history: Message[];
  /** Maps sender_id to a display name. */
  speakerNames: Map<string, string>;
}

function systemPrompt(params: AssembleParams): string {
  const where = params.chatName
    ? `You are in "${params.chatName}", a ${params.chatType} chat`
    : `You are in a ${params.chatType} chat`;

  return `You are Quorum, an assistant present in every conversation in this workspace.

${where} with ${params.memberNames.length} people: ${params.memberNames.join(', ')}.

You have already decided that speaking is appropriate — that decision is made
before you are called, so do not deliberate about whether to reply. Reply.

How to write here:
- You are one voice among several, not a chat window. Be brief.
- Answer the thing that was actually asked. No preamble, no summarising what
  people just said back to them, no offering further help.
- If you do not know, say so plainly and stop.
- Never claim to have done something you have not done.

You know only what is in this conversation. If you appear to know something
about someone that is not here, you are wrong — say you are not sure instead.`;
}

/**
 * Build the prompt, trimming oldest history first when over budget.
 *
 * Trim order matters and follows `CONTEXT.dropOrder`: tool results go first
 * (bulky and already summarised), then memory, then old history. The current
 * message is never dropped — a turn that trims away the thing it is answering
 * has failed rather than degraded.
 */
export function assembleContext(params: AssembleParams): AssembledContext {
  const system = systemPrompt(params);
  const dropped: string[] = [];

  const all: ProviderMessage[] = params.history.map((m) => ({
    role: m.sender_type === 'agent' ? ('assistant' as const) : ('user' as const),
    content:
      m.sender_type === 'agent'
        ? m.content
        : `${params.speakerNames.get(m.sender_id ?? '') ?? 'Someone'}: ${m.content}`,
  }));

  let messages = all.slice(-CONTEXT.historyMessages);
  if (messages.length < all.length) dropped.push('older_history');

  const budget = CONTEXT.tokenBudget - estimateTokens(system);
  let used = messages.reduce((n, m) => n + estimateTokens(m.content), 0);

  // Drop from the front — the oldest turns — while keeping at least the last
  // exchange, so the agent always has the message it is replying to.
  while (used > budget && messages.length > 2) {
    const removed = messages.shift()!;
    used -= estimateTokens(removed.content);
    if (!dropped.includes('older_history')) dropped.push('older_history');
  }

  // The API rejects a leading assistant turn.
  while (messages.length > 0 && messages[0].role === 'assistant') {
    messages = messages.slice(1);
    if (!dropped.includes('leading_assistant_turn')) dropped.push('leading_assistant_turn');
  }

  return {
    system,
    messages,
    dropped,
    estimatedTokens: estimateTokens(system) + used,
  };
}
