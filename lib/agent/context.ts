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

export interface MemoryLine {
  subjectName: string;
  content: string;
  sourceType: 'stated' | 'inferred';
}

export interface AssembleParams {
  chatName: string | null;
  chatType: string;
  memberNames: string[];
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

You know only what is in this conversation and in the notes below, if any. If
you seem to know something that is in neither, you are wrong — say you are not
sure instead.${memorySection(params)}`;
}

/**
 * Render the memory block.
 *
 * Everything here has already passed the surfacing rule in SQL, so the model is
 * never asked to decide what it may repeat — it cannot leak what it was not
 * given. The instruction below is about TACT, not about authorisation, and the
 * distinction is worth keeping straight: a prompt asking the model to be
 * discreet would be a mitigation, whereas not sending the item is a control.
 *
 * `stated` and `inferred` are surfaced because they mean different things to a
 * reader: one is what the person said, the other is what was deduced about
 * them, and the agent should not present the second as the first.
 */
function memorySection(params: AssembleParams): string {
  const memory = params.memory ?? [];
  if (memory.length === 0) return '';

  const lines = memory
    .map((m) => `- ${m.subjectName}: ${m.content}${m.sourceType === 'inferred' ? ' (inferred, not confirmed by them)' : ''}`)
    .join('\n');

  return `

What you already know about the people here:
${lines}

Everyone in this conversation is cleared to hear all of the above — it has been
filtered before reaching you. Use it where it helps. Do not recite it, do not
announce that you remember things, and do not bring up something personal just
because you can.`;
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
  let system = systemPrompt(params);
  const dropped: string[] = [];

  // Memory is dropped BEFORE history, per CONTEXT.dropOrder: losing a note is
  // recoverable, losing the message being replied to is not.
  if (estimateTokens(system) > CONTEXT.tokenBudget / 2 && (params.memory?.length ?? 0) > 0) {
    system = systemPrompt({ ...params, memory: [] });
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
