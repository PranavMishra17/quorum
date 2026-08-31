import { GATE } from '@/config';
import type { ChatType } from '@/lib/db/rows';

/**
 * The response gate: should the agent speak?
 *
 * A deterministic chain first, a model judge only for genuine ambiguity.
 *
 * "Let the LLM decide whether to respond" is unreproducible and untestable
 * exactly where it matters most — never answer yourself, stay out of someone
 * else's DM. Those are absolute rules, so they are code, and they are provable.
 * The judge exists for the residue.
 *
 * Everything in this file is PURE. No database, no clock of its own, no model
 * call. That is what makes the rules exhaustively testable, and it is why the
 * caller passes `now` rather than the function reading it.
 */

export type Verdict = 'respond' | 'silent';

export interface GateInput {
  message: {
    senderType: 'user' | 'agent';
    senderId: string | null;
    content: string;
  };
  chatType: ChatType;
  /** Active human members. A DM has two. */
  humanMemberCount: number;
  /** When the agent last spoke here, or null if it never has. */
  lastAgentMessageAt: Date | null;
  /** Whether this message is an explicit reply to an agent message. */
  repliesToAgent: boolean;
  now: Date;
}

export interface GateDecision {
  verdict: Verdict;
  /** Which rule fired. `fallthrough` means the judge must decide. */
  rule: string;
  reason: string;
}

export type ChainResult =
  | (GateDecision & { decided: true })
  | { decided: false; rule: 'fallthrough'; reason: string };

/**
 * Does this message address the agent?
 *
 * Tokens beginning with `@` are matched literally with a trailing boundary, so
 * `@quorumbot` does not count as `@quorum`. Bare-word tokens get full word
 * boundaries, so "inquorum" and "quorums" do not trigger a response — an agent
 * that answers because someone used a word in passing is exactly the failure
 * this gate exists to prevent.
 */
export function mentionsAgent(content: string): boolean {
  const text = content.toLowerCase();
  return GATE.mentionTokens.some((raw) => {
    const token = raw.toLowerCase();
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = token.startsWith('@')
      ? new RegExp(`${escaped}(?![\\w-])`)
      : new RegExp(`\\b${escaped}\\b`);
    return pattern.test(text);
  });
}

/**
 * Does this message OPEN by addressing the agent by name?
 *
 * Separate from `mentionsAgent` because these tokens are matched only at the
 * start. The agent is called Q on screen, so "q pull up my email" is the
 * obvious way to talk to it — and a bare `q` in the anywhere-matching list
 * would fire on "the q4 numbers" or a stray letter mid-sentence.
 *
 * Requires whitespace or punctuation after the name, so "queue", "quarterly"
 * and "agenda" are unaffected. A message that is ONLY the name also counts:
 * "quorum?" is addressed at it.
 */
export function addressesAgentByName(content: string): boolean {
  const text = content.trim().toLowerCase();
  return GATE.addressPrefixes.some((raw) => {
    const token = raw.toLowerCase();
    if (!text.startsWith(token)) return false;
    const next = text.charAt(token.length);
    // End of message, whitespace, or punctuation — but not a letter, digit,
    // hyphen or underscore, which would make it a different word.
    return next === '' || !/[\w-]/.test(next);
  });
}

/** True when the agent spoke recently enough that it should hold back. */
export function withinCooldown(
  lastAgentMessageAt: Date | null,
  now: Date,
  cooldownSeconds: number = GATE.cooldownSeconds,
): boolean {
  if (!lastAgentMessageAt) return false;
  const elapsedMs = now.getTime() - lastAgentMessageAt.getTime();
  return elapsedMs >= 0 && elapsedMs < cooldownSeconds * 1000;
}

/**
 * The deterministic chain. Evaluated in order; first match wins.
 *
 * Order is load-bearing. Rule 1 precedes everything because an agent that can
 * be provoked into answering itself loops forever, and no later rule can undo
 * that. Rules 3 and 4 precede rule 6 because an explicit address must always
 * beat the cooldown — otherwise a user who @-mentions the agent twice in quick
 * succession is ignored, which reads as broken rather than as restraint.
 */
export function evaluateChain(input: GateInput): ChainResult {
  // 1. Never respond to yourself. Loop guard, non-negotiable.
  if (input.message.senderType === 'agent') {
    return {
      decided: true, verdict: 'silent', rule: 'self',
      reason: 'the message was sent by the agent',
    };
  }

  // 2. A direct conversation with the agent. Everything here is addressed to it.
  if (input.chatType === 'agent') {
    return {
      decided: true, verdict: 'respond', rule: 'agent_chat',
      reason: 'this chat exists to talk to the agent',
    };
  }

  // 3. Explicitly named — either anywhere in the message (@quorum, @q) or as
  //     the opening word ("q, what does the MSA say?").
  if (mentionsAgent(input.message.content)) {
    return {
      decided: true, verdict: 'respond', rule: 'mention',
      reason: 'the agent was mentioned by name',
    };
  }
  if (addressesAgentByName(input.message.content)) {
    return {
      decided: true, verdict: 'respond', rule: 'addressed',
      reason: 'the message opens by addressing the agent by name',
    };
  }

  // 4. A reply to something the agent said.
  if (input.repliesToAgent) {
    return {
      decided: true, verdict: 'respond', rule: 'reply_to_agent',
      reason: 'the message replies to an agent message',
    };
  }

  // 5. Two humans in a DM who did not address the agent. It is present, but it
  //    is not a participant in someone else's private conversation.
  if (input.chatType === 'dm' && input.humanMemberCount === 2) {
    return {
      decided: true, verdict: 'silent', rule: 'unaddressed_dm',
      reason: 'a two-person DM the agent was not addressed in',
    };
  }

  // 6. Recently spoke, and nothing since is directed at it. Reached only after
  //    rules 3 and 4, so an explicit address always overrides the cooldown.
  if (withinCooldown(input.lastAgentMessageAt, input.now)) {
    return {
      decided: true, verdict: 'silent', rule: 'cooldown',
      reason: `the agent spoke within the last ${GATE.cooldownSeconds}s and was not addressed`,
    };
  }

  return {
    decided: false, rule: 'fallthrough',
    reason: 'no deterministic rule applied',
  };
}
