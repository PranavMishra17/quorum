import { describe, it, expect } from 'vitest';
import { GATE } from '@/config';
import {
  addressesAgentByName,
  evaluateChain,
  mentionsAgent,
  withinCooldown,
  type GateInput,
} from '@/lib/agent/gate';

/**
 * The deterministic chain is tested exhaustively BECAUSE it is deterministic.
 * The judge is not tested for taste — only for its contract, elsewhere.
 *
 * These need no database and no API key.
 */

const NOW = new Date('2026-08-30T12:00:00Z');

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    message: { senderType: 'user', senderId: 'u1', content: 'hello everyone' },
    chatType: 'group',
    humanMemberCount: 4,
    lastAgentMessageAt: null,
    repliesToAgent: false,
    now: NOW,
    ...over,
  };
}

describe('rule 1 — never respond to yourself', () => {
  it('is silent when the sender is the agent', () => {
    const r = evaluateChain(input({ message: { senderType: 'agent', senderId: null, content: 'hi' } }));
    expect(r).toMatchObject({ decided: true, verdict: 'silent', rule: 'self' });
  });

  it('beats EVERY other rule — an agent that can be provoked into answering itself loops forever', () => {
    const r = evaluateChain(input({
      message: { senderType: 'agent', senderId: null, content: '@quorum what do you think?' },
      chatType: 'agent',
      repliesToAgent: true,
    }));
    expect(r).toMatchObject({ verdict: 'silent', rule: 'self' });
  });
});

describe('rule 2 — an agent chat is a direct conversation', () => {
  it('responds to anything', () => {
    const r = evaluateChain(input({ chatType: 'agent', humanMemberCount: 1 }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'agent_chat' });
  });

  it('responds even inside the cooldown', () => {
    const r = evaluateChain(input({
      chatType: 'agent', humanMemberCount: 1,
      lastAgentMessageAt: new Date(NOW.getTime() - 1000),
    }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'agent_chat' });
  });
});

describe('rule 3 — mentions', () => {
  it.each(GATE.mentionTokens)('responds to the token %s', (token) => {
    const r = evaluateChain(input({
      message: { senderType: 'user', senderId: 'u1', content: `hey ${token}, thoughts?` },
    }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'mention' });
  });

  it('is case-insensitive', () => {
    expect(mentionsAgent('QUORUM, are you there')).toBe(true);
    expect(mentionsAgent('@QuOrUm hello')).toBe(true);
  });

  it('does NOT fire on a word that merely contains the token', () => {
    // The failure this prevents: an agent that answers because someone used a
    // word in passing is exactly what the gate exists to stop.
    expect(mentionsAgent('we lack a quorums count')).toBe(false);
    expect(mentionsAgent('inquorum is not a word but still')).toBe(false);
    expect(mentionsAgent('@quorumbot is a different bot')).toBe(false);
  });

  it('fires on sensible punctuation around the token', () => {
    expect(mentionsAgent('quorum: what next?')).toBe(true);
    expect(mentionsAgent('(quorum)')).toBe(true);
    expect(mentionsAgent('...quorum!')).toBe(true);
  });

  it('overrides the cooldown — a second mention must not be ignored', () => {
    const r = evaluateChain(input({
      message: { senderType: 'user', senderId: 'u1', content: '@quorum again please' },
      lastAgentMessageAt: new Date(NOW.getTime() - 1000),
    }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'mention' });
  });

  it('overrides the unaddressed-DM rule', () => {
    const r = evaluateChain(input({
      chatType: 'dm', humanMemberCount: 2,
      message: { senderType: 'user', senderId: 'u1', content: 'quorum, settle this for us' },
    }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'mention' });
  });
});

describe('rule 4 — a reply to the agent', () => {
  it('responds', () => {
    const r = evaluateChain(input({ repliesToAgent: true }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'reply_to_agent' });
  });

  it('overrides the cooldown', () => {
    const r = evaluateChain(input({
      repliesToAgent: true,
      lastAgentMessageAt: new Date(NOW.getTime() - 1000),
    }));
    expect(r).toMatchObject({ verdict: 'respond', rule: 'reply_to_agent' });
  });
});

describe('rule 5 — a DM between two humans', () => {
  it('stays silent when not addressed', () => {
    // Present, but not a participant in someone else's private conversation.
    const r = evaluateChain(input({ chatType: 'dm', humanMemberCount: 2 }));
    expect(r).toMatchObject({ verdict: 'silent', rule: 'unaddressed_dm' });
  });

  it('does not apply to a group', () => {
    const r = evaluateChain(input({ chatType: 'group', humanMemberCount: 2 }));
    expect(r).toMatchObject({ decided: false, rule: 'fallthrough' });
  });
});

describe('rule 6 — cooldown', () => {
  it('suppresses a rapid second response', () => {
    const r = evaluateChain(input({ lastAgentMessageAt: new Date(NOW.getTime() - 5_000) }));
    expect(r).toMatchObject({ verdict: 'silent', rule: 'cooldown' });
  });

  it('expires exactly at the configured boundary', () => {
    const ms = GATE.cooldownSeconds * 1000;
    expect(withinCooldown(new Date(NOW.getTime() - (ms - 1)), NOW)).toBe(true);
    expect(withinCooldown(new Date(NOW.getTime() - ms), NOW)).toBe(false);
  });

  it('does not apply when the agent has never spoken', () => {
    expect(withinCooldown(null, NOW)).toBe(false);
  });

  it('ignores a timestamp in the future rather than suppressing forever', () => {
    // Clock skew between the database and the runtime must not mute the agent.
    expect(withinCooldown(new Date(NOW.getTime() + 60_000), NOW)).toBe(false);
  });
});

describe('fallthrough', () => {
  it('defers to the judge for an unaddressed group message', () => {
    const r = evaluateChain(input());
    expect(r).toEqual({
      decided: false, rule: 'fallthrough', reason: 'no deterministic rule applied',
    });
  });

  it('defers for a group DM-like chat with more than two people', () => {
    const r = evaluateChain(input({ chatType: 'dm', humanMemberCount: 3 }));
    expect(r.decided).toBe(false);
  });
});

describe('the chain is pure', () => {
  it('gives the same answer for the same input', () => {
    const i = input({ lastAgentMessageAt: new Date(NOW.getTime() - 5_000) });
    expect(evaluateChain(i)).toEqual(evaluateChain(i));
  });

  it('takes its clock as an argument, so cooldown behaviour is testable', () => {
    const last = new Date(NOW.getTime() - 5_000);
    const soon = evaluateChain(input({ lastAgentMessageAt: last }));
    const later = evaluateChain(input({
      lastAgentMessageAt: last,
      now: new Date(NOW.getTime() + GATE.cooldownSeconds * 1000),
    }));
    expect(soon).toMatchObject({ verdict: 'silent', rule: 'cooldown' });
    expect(later.decided).toBe(false);
  });

  it('every decided outcome carries a rule and a human-readable reason', () => {
    const cases: GateInput[] = [
      input({ message: { senderType: 'agent', senderId: null, content: 'x' } }),
      input({ chatType: 'agent' }),
      input({ message: { senderType: 'user', senderId: 'u1', content: '@quorum hi' } }),
      input({ repliesToAgent: true }),
      input({ chatType: 'dm', humanMemberCount: 2 }),
      input({ lastAgentMessageAt: new Date(NOW.getTime() - 1000) }),
    ];
    for (const c of cases) {
      const r = evaluateChain(c);
      expect(r.decided).toBe(true);
      expect(r.rule).toBeTruthy();
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});


/**
 * Addressing the agent as "Q".
 *
 * This was a real, reported failure: the tile on the home page says Q, so a user
 * typed "q pull up my email data" and was ignored three times in a row, because
 * the mention list held only `@quorum`. An agent that ignores its own name reads
 * as broken, not as restrained — which is the opposite of what the gate is for.
 */
describe('the agent answers to Q', () => {
  const dm = (content: string) =>
    evaluateChain(
      input({ chatType: 'dm', humanMemberCount: 2, message: { senderType: 'user', senderId: 'u1', content } }),
    );

  it.each([
    'q pull up my email data',
    'Q, what does the contract say?',
    'q: summarise this',
    'quorum can you help',
    'agent what is the term',
  ])('responds when the message opens with a name it answers to: %s', (content) => {
    expect(dm(content)).toMatchObject({ decided: true, verdict: 'respond' });
  });

  it.each(['@q pull up my email', '@quorum hello', '@agent hello'])(
    'responds to an @-mention anywhere: %s',
    (content) => {
      expect(dm(content)).toMatchObject({ decided: true, verdict: 'respond', rule: 'mention' });
    },
  );

  /**
   * The reason a bare `q` is a LEADING-only token rather than a mention token:
   * matched anywhere, it fires on ordinary prose, and an agent that barges into
   * a private conversation because someone wrote "q4" is worse than one that
   * misses a greeting.
   */
  it.each([
    'the q4 numbers look wrong',
    'add this to the queue please',
    'quarterly review is on Thursday',
    'I asked a question',
    'send it to hq for signing',
  ])('stays out of a DM that merely contains a q-word: %s', (content) => {
    expect(dm(content)).toMatchObject({ decided: true, verdict: 'silent', rule: 'unaddressed_dm' });
  });

  it('a name alone counts as addressing it', () => {
    expect(addressesAgentByName('q?')).toBe(true);
    expect(addressesAgentByName('quorum')).toBe(true);
  });

  it('requires a boundary after the name', () => {
    expect(addressesAgentByName('queue the file')).toBe(false);
    expect(addressesAgentByName('q-tip')).toBe(false);
    expect(addressesAgentByName('quorums are hard')).toBe(false);
  });

  it('ignores leading whitespace, as a paste would leave', () => {
    expect(addressesAgentByName('   q what is this')).toBe(true);
  });

  it('only matches at the START — mid-sentence does not count', () => {
    expect(addressesAgentByName('can you ask q about this')).toBe(false);
  });

  it('every configured prefix is matched, so config and code cannot drift', () => {
    for (const token of GATE.addressPrefixes) {
      expect(addressesAgentByName(`${token} hello`), token).toBe(true);
    }
  });

  it('reports its own rule name, distinct from an @-mention', () => {
    expect(dm('q hello')).toMatchObject({ rule: 'addressed' });
    expect(dm('@q hello')).toMatchObject({ rule: 'mention' });
  });
});
