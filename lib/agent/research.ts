import { KILL_SWITCHES, RESEARCH_TOOL } from '@/config';
import { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { logEvent } from '@/lib/events/log';
import { AnthropicProvider } from '@/lib/llm/anthropic';
import { instrument } from '@/lib/llm/instrumented';
import { toLlmError } from '@/lib/llm/errors';
import { researchPrompt } from './prompts';
import { checkRateLimit } from './orchestrator';
import { openToolSession, toolDefinition } from './tools';
import type { ProviderMessage } from '@/lib/llm/provider';

/**
 * A research turn — bounded, multi-step, and USER-INVOKED.
 *
 * Triggered by `/research <question>`. It is a separate turn type rather than a
 * tool inside the normal loop, and the separation is the design:
 *
 * **The gate is bypassed, deliberately.** Asking a direct question is the
 * clearest possible signal that a reply is wanted; running it past a judge
 * biased toward silence would be theatre. The rate limit still applies, above
 * everything — a user who can force a reply by asking must not be able to force
 * unlimited replies by asking repeatedly, and this is the most expensive turn
 * type in the system.
 *
 * **It gets its own budget.** `RESEARCH_TOOL.timeoutMs` is 180s against the
 * automatic loop's 60s. That number only makes sense outside the automatic
 * loop, which is exactly why `research` was moved out of `TOOLS.perTool` — it
 * had been sitting inside a 60s ceiling, where it was dead configuration.
 *
 * ---------------------------------------------------------------------------
 * IT INHERITS EVERY BOUND, INCLUDING THE ONES THAT MAKE IT LESS USEFUL
 *
 * It uses the same `ToolSession`, so D-022 applies unchanged: the moment it
 * reads a document, externally-observable tools disappear for the rest of the
 * turn. That genuinely constrains research — read a contract and you can no
 * longer fetch a page about it — and the constraint is correct. A turn that has
 * ingested attacker-authored text is precisely the turn that must not then be
 * able to make a request an attacker can observe.
 *
 * The alternative would be a research-specific exemption, which is how a
 * least-privilege rule becomes a rule with an exception for the one case that
 * matters. The model is told what happened, and says so in its answer.
 */

export interface ResearchParams {
  chatId: string;
  actorId: string;
  turnId: string;
  requestId: string;
  /** The message carrying the `/research` request. */
  messageId: string;
  question: string;
}

export interface ResearchResult {
  spoke: boolean;
  reason?: string;
  steps?: number;
  agentMessageId?: string;
}

export async function runResearchTurn(params: ResearchParams): Promise<ResearchResult> {
  const startedAt = performance.now();

  // Fails closed, like every turn: no context unless the actor passes both
  // axes right now.
  const ctx = await ScopedAgentContext.open(params);

  // `turn_started` rather than a research-specific type, so this turn counts
  // against the same rate-limit window the automatic turns use. A separate
  // event type would have made research the way to bypass the limit.
  await logEvent(ctx, 'turn_started', { message_id: params.messageId, kind: 'research' });

  try {
    const limit = await checkRateLimit(ctx);
    if (limit) {
      await logEvent(ctx, 'rate_limited', { ...limit, kind: 'research' });
      await logEvent(ctx, 'turn_completed', { spoke: false, reason: 'rate_limited' });
      return { spoke: false, reason: 'rate_limited' };
    }

    if (!KILL_SWITCHES.agentEnabled) {
      await logEvent(ctx, 'turn_completed', { spoke: false, reason: 'agent_disabled' });
      return { spoke: false, reason: 'agent_disabled' };
    }

    const chat = await ctx.chatSummary();
    const session = openToolSession(ctx, chat.type, params.messageId);

    await logEvent(ctx, 'research_started', {
      max_steps: RESEARCH_TOOL.maxSteps,
      budget_ms: RESEARCH_TOOL.timeoutMs,
      question_chars: params.question.length,
      tools_offered: session?.availableTools().map((t) => t.name) ?? [],
    }, params.messageId);

    const provider = instrument(new AnthropicProvider(), ctx, params.messageId);
    const transcript = await recentContext(ctx);

    const messages: ProviderMessage[] = [
      {
        role: 'user',
        content:
          `${transcript}\n\nResearch question from a colleague in this conversation:\n\n${params.question}`,
      },
    ];

    let text = '';
    let steps = 0;
    let stoppedBy: 'answered' | 'step_budget' | 'time_budget' = 'answered';

    for (steps = 0; steps <= RESEARCH_TOOL.maxSteps; steps++) {
      // Checked at the top of each round rather than raced against the model
      // call. A timer that fires mid-call does not stop the work, it only stops
      // waiting for it — and it would throw away a completed answer we have
      // already paid for.
      if (performance.now() - startedAt > RESEARCH_TOOL.timeoutMs) {
        stoppedBy = 'time_budget';
        break;
      }
      if (steps === RESEARCH_TOOL.maxSteps) {
        stoppedBy = 'step_budget';
        // Fall through to one final call with no tools, so the budget ends in
        // an answer rather than in silence. A research turn that spends its
        // whole allowance and then says nothing is the worst of both.
      }

      // Recomputed every round: after untrusted content is read, the
      // externally-observable tools are not declined, they are not offered.
      const offered = stoppedBy === 'step_budget' ? [] : session?.availableTools() ?? [];

      const result = await provider.complete({
        purpose: 'research_synthesis',
        system: researchPrompt(RESEARCH_TOOL.maxSteps),
        messages,
        tools: offered.length ? offered.map(toolDefinition) : undefined,
      });

      if (result.text.trim()) text = result.text.trim();
      if (!result.toolUses?.length || !session || stoppedBy === 'step_budget') break;

      messages.push({ role: 'assistant', content: result.raw ?? [] });

      const results = [];
      for (const use of result.toolUses) {
        const outcome = await session.invoke(use.name, use.input);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: outcome.status !== 'ok',
          content:
            outcome.status === 'ok'
              ? outcome.content
              : `This tool did not run: ${outcome.reason}. Continue without it, and say so in your answer if it matters.`,
        });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!text) {
      throw new Error('the research turn produced no answer');
    }

    const message = await ctx.writeAgentMessage(text);

    await logEvent(ctx, 'research_finished', {
      steps,
      stopped_by: stoppedBy,
      duration_ms: Math.round(performance.now() - startedAt),
      touched_untrusted_content: session?.touchedUntrustedContent ?? false,
      answer_chars: text.length,
    }, message.id);

    await logEvent(ctx, 'turn_completed', {
      spoke: true,
      reason: 'research',
      duration_ms: Math.round(performance.now() - startedAt),
    });

    return { spoke: true, steps, agentMessageId: message.id };
  } catch (err) {
    const llmError = toLlmError(err);
    await logEvent(ctx, 'turn_failed', {
      kind: 'research',
      error: llmError.kind,
      message: llmError.message,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    // A failed research turn must not take the chat with it, for the same
    // reason a failed ordinary turn must not.
    return { spoke: false, reason: llmError.kind };
  }
}

/**
 * Recent conversation, as context for the question.
 *
 * Deliberately NOT the memory system. Memory answers "what do I know about
 * these people"; research answers "what do these documents say". Retrieving
 * personal facts into a research prompt would put them into an answer that the
 * whole chat reads, through a path that never asked whether they belong there.
 * The surfacing rule would still hold — but the right move is not to ask.
 */
async function recentContext(ctx: ScopedAgentContext): Promise<string> {
  const [history, names] = await Promise.all([
    ctx.recentMessages(20),
    ctx.speakerNames(),
  ]);

  const lines = history.map(
    (m) =>
      `${m.sender_type === 'agent' ? 'assistant' : names.get(m.sender_id ?? '') ?? 'Someone'}: ${m.content}`,
  );

  return `Recent conversation, for context:\n${lines.join('\n')}`;
}

/**
 * Is this message a research request, and what is the question?
 *
 * Exported and pure so the parsing rules are testable without a turn. A
 * bare `/research` with no question is NOT a request — dispatching an
 * expensive reason-tier turn on an empty string is the kind of thing a stray
 * keystroke should not be able to do.
 */
export function parseResearchCommand(content: string): string | null {
  const match = /^\/research\b\s*([\s\S]*)$/i.exec(content.trim());
  if (!match) return null;
  const question = match[1].trim();
  return question.length > 0 ? question : null;
}
