import { KILL_SWITCHES, GATE, RATE_LIMITS, MEMORY, TOOLS } from '@/config';
import { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { logEvent } from '@/lib/events/log';
import { AnthropicProvider } from '@/lib/llm/anthropic';
import { instrument } from '@/lib/llm/instrumented';
import { toLlmError } from '@/lib/llm/errors';
import { assembleContext, type MemoryLine } from './context';
import { retrieveMemory } from '@/lib/memory/retrieve';
import { extractMemory } from '@/lib/memory/extract';

import { evaluateChain, type GateDecision, type GateInput } from './gate';
import { judge } from './judge';
import { openToolSession, toolDefinition, type ToolSession } from './tools';

/**
 * The agent turn.
 *
 *   open context → gate → assemble → model → persist
 *
 * Every step writes an `agent_events` row, including the steps that decide to
 * do nothing. A turn that ends in silence still produces a full trace, because
 * "the agent said nothing" and "the agent never ran" look identical in a chat
 * window and must not look identical in the log.
 *
 * Memory joins the pipeline here, and only now: the isolation tests were
 * written and passing before `retrieve.ts` existed. A half-built memory system
 * with no isolation is worse than none — it demonstrates the exact leak this
 * project claims to solve.
 */

export interface TurnParams {
  chatId: string;
  actorId: string;
  turnId: string;
  requestId: string;
  messageId: string;
}

export interface TurnResult {
  spoke: boolean;
  decision: GateDecision;
  agentMessageId?: string;
}

export async function runTurn(params: TurnParams): Promise<TurnResult> {
  const startedAt = performance.now();

  // Fails closed: if the actor cannot access the chat on both axes right now,
  // no context exists and the turn never starts.
  const ctx = await ScopedAgentContext.open(params);

  await logEvent(ctx, 'turn_started', { message_id: params.messageId });

  try {
    // Rate limiting sits ABOVE the gate, so it applies even to an explicit
    // mention. A user who can force a response by naming the agent can
    // otherwise force unlimited responses by naming it repeatedly.
    const limit = await checkRateLimit(ctx);
    if (limit) {
      await logEvent(ctx, 'rate_limited', limit);
      const decision: GateDecision = {
        verdict: 'silent', rule: 'rate_limited',
        reason: `the agent is rate limited in this chat (${limit.window})`,
      };
      await logEvent(ctx, 'turn_completed', { spoke: false, reason: decision.rule });
      return { spoke: false, decision };
    }

    if (!KILL_SWITCHES.agentEnabled) {
      // The supplied key is short-lived. This lets the product degrade to a
      // plain chat from an environment variable, with the reason recorded,
      // rather than erroring in front of a user.
      const decision: GateDecision = {
        verdict: 'silent', rule: 'agent_disabled',
        reason: 'the agent is switched off by configuration',
      };
      await logEvent(ctx, 'gate_evaluated', { ...decision, duration_ms: 0 });
      await logEvent(ctx, 'turn_completed', { spoke: false, reason: decision.rule });
      return { spoke: false, decision };
    }

    const decision = await decideWhetherToSpeak(ctx, params.messageId, startedAt);

    if (decision.verdict === 'silent') {
      await logEvent(ctx, 'turn_completed', {
        spoke: false,
        reason: decision.rule,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return { spoke: false, decision };
    }

    const { messageId: agentMessageId, session } = await speak(ctx, params.messageId);

    // Extraction runs AFTER the reply is persisted and broadcast (D-013). By
    // this point the user already has their answer, so a slow or failing
    // extraction costs nothing user-visible.
    if (KILL_SWITCHES.memoryWriteEnabled) {
      await extractTurnMemory(ctx, agentMessageId, session?.touchedUntrustedContent ?? false);
    }

    await logEvent(ctx, 'turn_completed', {
      spoke: true,
      reason: decision.rule,
      duration_ms: Math.round(performance.now() - startedAt),
    }, agentMessageId);

    return { spoke: true, decision, agentMessageId };
  } catch (err) {
    const llmError = toLlmError(err);
    // A broken agent must never take the chat down. The failure is recorded and
    // visible in the internal view; the conversation carries on without it.
    await logEvent(ctx, 'turn_failed', {
      error_kind: llmError.kind,
      message: llmError.message,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return {
      spoke: false,
      decision: {
        verdict: 'silent', rule: 'turn_failed',
        reason: `the turn failed (${llmError.kind})`,
      },
    };
  }
}

/**
 * Per-chat rate limiting, counted from the append-only event log.
 *
 * Counting rows rather than keeping an in-memory counter is deliberate:
 * serverless instances do not share memory, so an in-process limiter would
 * permit N times the intended rate across N instances while appearing to work
 * locally. The event log is the one place every instance agrees on.
 *
 * The current turn's own `turn_started` row is already written, hence `>`.
 */
export async function checkRateLimit(
  ctx: ScopedAgentContext,
): Promise<{ window: string; count: number; limit: number } | null> {
  const windows = [
    { window: 'minute', seconds: 60, limit: RATE_LIMITS.agentTurnsPerChatPerMinute },
    { window: 'hour', seconds: 3600, limit: RATE_LIMITS.agentTurnsPerChatPerHour },
  ];

  for (const w of windows) {
    const since = new Date(Date.now() - w.seconds * 1000).toISOString();
    const { count, error } = await ctx
      .privilegedClient()
      .from('agent_events')
      .select('id', { count: 'exact', head: true })
      .eq('chat_id', ctx.chatId)
      .eq('event_type', 'turn_started')
      .gte('created_at', since);

    // Fail OPEN on a counting error. A database hiccup should not silence the
    // agent — the kill switch exists for deliberate silencing, and the caps
    // below are a guard against runaway loops, not a security control.
    if (error || count === null) continue;

    if (count > w.limit) {
      return { window: w.window, count, limit: w.limit };
    }
  }
  return null;
}

/** Deterministic chain first; the judge only for what falls through. */
async function decideWhetherToSpeak(
  ctx: ScopedAgentContext,
  messageId: string,
  startedAt: number,
): Promise<GateDecision> {
  const [history, memberIds] = await Promise.all([
    ctx.recentMessages(GATE.judgeContextMessages),
    ctx.activeMemberIds(),
  ]);

  const current = history.find((m) => m.id === messageId) ?? history[history.length - 1];
  const priorAgent = [...history].reverse().find((m) => m.sender_type === 'agent');
  const chat = await ctx.chatSummary();

  const gateInput: GateInput = {
    message: {
      senderType: current?.sender_type ?? 'user',
      senderId: current?.sender_id ?? null,
      content: current?.content ?? '',
    },
    chatType: chat.type,
    humanMemberCount: memberIds.length,
    lastAgentMessageAt: priorAgent ? new Date(priorAgent.created_at) : null,
    // Threaded replies are not modelled in v1, so this is always false. Left in
    // the input shape because rule 4 is part of the specified chain and hiding
    // it would misrepresent what the gate does.
    repliesToAgent: false,
    now: new Date(),
  };

  const chain = evaluateChain(gateInput);

  const decision: GateDecision = chain.decided
    ? { verdict: chain.verdict, rule: chain.rule, reason: chain.reason }
    : await judge(instrument(new AnthropicProvider(), ctx, messageId), {
        chatName: chat.name,
        memberCount: memberIds.length,
        transcript: await renderTranscript(ctx, history),
      });

  await logEvent(ctx, 'gate_evaluated', {
    ...decision,
    duration_ms: Math.round(performance.now() - startedAt),
  }, messageId);

  return decision;
}

async function renderTranscript(
  ctx: ScopedAgentContext,
  history: Awaited<ReturnType<ScopedAgentContext['recentMessages']>>,
) {
  const names = await ctx.speakerNames();
  return history.map((m) => ({
    speaker: names.get(m.sender_id ?? '') ?? 'Someone',
    content: m.content,
    isAgent: m.sender_type === 'agent',
  }));
}

/** Assemble, call the model, run the tool loop, persist the reply. */
async function speak(
  ctx: ScopedAgentContext,
  messageId: string,
): Promise<{ messageId: string; session: ToolSession | null }> {
  const [history, names, chat, memberIds, clearanceLabel] = await Promise.all([
    ctx.recentMessages(60),
    ctx.speakerNames(),
    ctx.chatSummary(),
    ctx.activeMemberIds(),
    ctx.clearanceLabel(),
  ]);

  const current = history.find((m) => m.id === messageId);

  // Retrieval. Everything it returns has already passed the surfacing rule in
  // SQL — assembly below does no filtering of its own and must never be handed
  // an unfiltered set.
  const retrieved = await retrieveMemory(ctx, {
    query: current?.content ?? '',
    // Speaker presence: a fact about someone who just spoke is far more likely
    // to matter than one about a person who has not appeared.
    recentSpeakerIds: history
      .slice(-8)
      .map((m) => m.sender_id)
      .filter((id): id is string => Boolean(id)),
  });

  const memory: MemoryLine[] = retrieved.items.map((i) => ({
    subjectName: names.get(i.subjectUserId) ?? 'Someone',
    content: i.content,
    sourceType: i.sourceType,
  }));

  const assembled = assembleContext({
    chatName: chat.name,
    chatType: chat.type,
    memberNames: memberIds.map((id) => names.get(id) ?? 'Someone'),
    clearanceLabel,
    history,
    speakerNames: names,
    memory,
  });

  if (assembled.dropped.length > 0) {
    await logEvent(ctx, 'context_dropped', {
      dropped: assembled.dropped,
      token_budget: assembled.estimatedTokens,
      estimated_tokens: assembled.estimatedTokens,
    }, messageId);
  }

  const provider = instrument(new AnthropicProvider(), ctx, messageId);
  const session = openToolSession(ctx, chat.type, messageId);

  // The conversation as the model sees it, growing as tools are used.
  const messages = [...assembled.messages];
  let text = '';

  // The loop is bounded twice over: TOOLS.maxCallsPerTurn inside the session,
  // and this iteration count outside it. Two bounds because they fail
  // differently — the session's cap stops a runaway tool, this one stops a
  // model that keeps asking for tools it has been refused.
  for (let round = 0; round <= TOOLS.maxCallsPerTurn; round++) {
    // Tools are recomputed EVERY round, not once. After untrusted content is
    // read, the externally-observable ones disappear from the offer — the model
    // is not asked to decline them, it is not shown them (D-022).
    const offered = session?.availableTools() ?? [];

    const result = await provider.complete({
      purpose: 'chat_response',
      system: assembled.system,
      messages,
      tools: offered.length ? offered.map(toolDefinition) : undefined,
    });

    if (result.text.trim()) text = result.text.trim();

    if (!result.toolUses?.length || !session) break;

    // Echo the assistant turn back verbatim, then answer every tool_use in ONE
    // user message. Splitting them across messages silently trains the model
    // out of making parallel calls.
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
            : `This tool did not run: ${outcome.reason}. Answer without it, and say so if it matters.`,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  if (!text) {
    // An empty completion is not a reply. Writing it would put a blank bubble
    // in the chat, which reads as a bug rather than as restraint.
    throw new Error('the model returned an empty response');
  }

  const message = await ctx.writeAgentMessage(text);
  return { messageId: message.id, session };
}

/**
 * Deferred extraction.
 *
 * `touchedUntrustedContent` comes from the turn's ToolSession. Getting it wrong
 * is T10: a fact planted by injected content, stored as `active`, surfacing
 * forever. When true, everything extracted is forced to `inferred` +
 * `candidate` and is therefore never retrieved.
 */
async function extractTurnMemory(
  ctx: ScopedAgentContext,
  agentMessageId: string,
  touchedUntrustedContent: boolean,
): Promise<void> {
  const [history, names] = await Promise.all([
    ctx.recentMessages(MEMORY.extraction.contextMessages),
    ctx.speakerNames(),
  ]);

  await extractMemory(ctx, {
    provider: instrument(new AnthropicProvider(), ctx, agentMessageId),
    transcript: history.map((m) => ({
      speakerId: m.sender_id,
      speaker: names.get(m.sender_id ?? '') ?? 'Someone',
      content: m.content,
      isAgent: m.sender_type === 'agent',
    })),
    touchedUntrustedContent,
    originMessageId: agentMessageId,
  });
}
