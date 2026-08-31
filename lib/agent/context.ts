import { CONTEXT } from '@/config';
import type { Message } from '@/lib/db/rows';
import type { ProviderMessage } from '@/lib/llm/provider';
import { replyPrompt, type MemoryLine } from './prompts';

export type { MemoryLine };

/**
 * Prompt assembly within a token budget.
 *
 * The budget is deliberately far below the model's 1M window: cost and
 * precision degrade long before the window does, and a prompt that includes
 * everything is not the same as a prompt that includes the right things.
 *
 * The prompt TEXT lives in `./prompts`. This file owns the budget and the
 * trimming; it does not own the words.
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

/**
 * A provider message carries either a string or raw content blocks (the latter
 * only when replaying a tool exchange). Assembly measures both the same way.
 */
function sizeOf(content: string | unknown[]): number {
  return estimateTokens(typeof content === 'string' ? content : JSON.stringify(content));
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
  /** This room's own clearance requirement, named — null when ungated. Never
   * the actor's own held level, never another chat's requirement. */
  clearanceLabel?: { level: number; name: string } | null;
  history: Message[];
  /** Maps sender_id to a display name. */
  speakerNames: Map<string, string>;
  /**
   * Memory items that have ALREADY passed the surfacing rule. Anything reaching
   * this parameter is authorised for this chat; assembly does no filtering and
   * must never be given an unfiltered set.
   */
  memory?: MemoryLine[];
}

/**
 * Build the prompt, trimming to fit the budget.
 *
 * Drop order follows `CONTEXT.dropOrder`: memory before history. Losing a note
 * degrades the answer; losing the message being replied to breaks the turn. The
 * current exchange is never dropped — a turn that trims away the thing it is
 * answering has failed rather than degraded.
 */
export function assembleContext(params: AssembleParams): AssembledContext {
  const memory = params.memory ?? [];
  const dropped: string[] = [];

  let system = replyPrompt({
    chatName: params.chatName,
    chatType: params.chatType,
    memberNames: params.memberNames,
    clearanceLabel: params.clearanceLabel ?? null,
    memory,
  });

  // Memory goes first if the system prompt alone is eating the budget.
  if (estimateTokens(system) > CONTEXT.tokenBudget / 2 && memory.length > 0) {
    system = replyPrompt({
      chatName: params.chatName,
      chatType: params.chatType,
      memberNames: params.memberNames,
      clearanceLabel: params.clearanceLabel ?? null,
      memory: [],
    });
    dropped.push('memory');
  }

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
  let used = messages.reduce((n, m) => n + sizeOf(m.content), 0);

  // Drop from the front — the oldest turns — while keeping at least the last
  // exchange, so the agent always has the message it is replying to.
  while (used > budget && messages.length > 2) {
    const removed = messages.shift()!;
    used -= sizeOf(removed.content);
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
