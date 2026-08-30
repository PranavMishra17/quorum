import { describe, it, expect } from 'vitest';
import { describeEvent, summariseTurn, type EventRow } from '@/app/_components/event-trace';
import { matchingCommands, SLASH_COMMANDS } from '@/app/_components/slash-commands';

/**
 * The inline chat-viewport trace and the collapsed full audit panel
 * (`internal-view.tsx`) both render through these two functions. That sharing
 * is the point: two copies of "3 items surfaced" phrased slightly differently
 * would undermine the exact thing meant to make the panel trustworthy.
 */

const at = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs).toISOString();

const ev = (type: string, payload: Record<string, unknown>, offsetMs = 0): EventRow => ({
  id: `${type}-${offsetMs}`,
  turn_id: 't1',
  event_type: type,
  payload,
  created_at: at(offsetMs),
});

describe('describeEvent', () => {
  it('names what the authorisation filter withheld, not just what surfaced', () => {
    const line = describeEvent(ev('memory_retrieved', { kept: 2, filtered_out: 3, capped_out: 0 }));
    expect(line).toContain('2 items surfaced');
    expect(line).toContain('3 withheld');
  });

  it('says nothing extra when nothing was withheld', () => {
    const line = describeEvent(ev('memory_retrieved', { kept: 1, filtered_out: 0, capped_out: 0 }));
    expect(line).not.toContain('withheld');
  });

  it('makes a blocked exfiltration attempt readable as one line', () => {
    const line = describeEvent(ev('tool_call_blocked_untrusted', { tool: 'web_fetch', reason: 'this turn has read untrusted content' }));
    expect(line).toContain('web_fetch BLOCKED');
  });

  it('flags untrusted tool output distinctly from an ordinary result', () => {
    expect(describeEvent(ev('tool_result', { tool: 'file_read', untrusted: true }))).toContain('UNTRUSTED');
    expect(describeEvent(ev('tool_result', { tool: 'file_list', untrusted: false }))).not.toContain('UNTRUSTED');
  });

  it('describes a silent turn by its reason', () => {
    expect(describeEvent(ev('turn_completed', { spoke: false, reason: 'not_addressed' })))
      .toBe('stayed quiet (not_addressed)');
  });

  it('falls back to raw payload only for an unrecognised event type', () => {
    expect(describeEvent(ev('some_future_event', { x: 1 }))).toContain('"x":1');
    expect(describeEvent(ev('some_future_event', {}))).toBe('');
  });
});

describe('summariseTurn', () => {
  it('is unfinished with no verdict while the turn is still running', () => {
    const turn = summariseTurn('t1', [ev('turn_started', {}, 0)]);
    expect(turn.finished).toBe(false);
    expect(turn.verdict).toBeUndefined();
  });

  it('reports the gate verdict and rule once evaluated', () => {
    const turn = summariseTurn('t1', [
      ev('turn_started', {}, 0),
      ev('gate_evaluated', { verdict: 'respond', rule: 'mentioned', reason: 'named directly' }, 10),
      ev('turn_completed', { spoke: true }, 20),
    ]);
    expect(turn.verdict).toBe('respond');
    expect(turn.rule).toBe('mentioned');
    expect(turn.finished).toBe(true);
  });

  it('a research turn reports as "research", not as an unresolved gate', () => {
    const turn = summariseTurn('t1', [
      ev('turn_started', {}, 0),
      ev('research_started', { max_steps: 5 }, 5),
      ev('research_finished', { steps: 2, stopped_by: 'answered' }, 15),
      ev('turn_completed', { spoke: true }, 16),
    ]);
    expect(turn.verdict).toBe('research');
    expect(turn.rule).toMatch(/gate bypassed/);
  });

  it('order does not matter — events are sorted before summarising', () => {
    const inOrder = summariseTurn('t1', [
      ev('turn_started', {}, 0),
      ev('gate_evaluated', { verdict: 'silent', rule: 'cooldown' }, 10),
      ev('turn_completed', { spoke: false, reason: 'cooldown' }, 20),
    ]);
    const shuffled = summariseTurn('t1', [
      ev('turn_completed', { spoke: false, reason: 'cooldown' }, 20),
      ev('turn_started', {}, 0),
      ev('gate_evaluated', { verdict: 'silent', rule: 'cooldown' }, 10),
    ]);
    expect(shuffled).toEqual(inOrder);
  });

  it('joins cost and tokens from llm_calls scoped to THIS turn only', () => {
    const turn = summariseTurn('t1', [ev('turn_started', {})], [
      { id: 'c1', turn_id: 't1', purpose: 'chat_response', model: 'x', status: 'succeeded', input_tokens: 100, output_tokens: 50, cost_estimate: '0.01' },
      { id: 'c2', turn_id: 'OTHER-TURN', purpose: 'chat_response', model: 'x', status: 'succeeded', input_tokens: 9999, output_tokens: 9999, cost_estimate: '9.99' },
    ]);
    expect(turn.tokens).toBe(150);
    expect(turn.cost).toBeCloseTo(0.01);
  });

  describe('the live status line — what a viewer sees WHILE a turn is running', () => {
    const runningTurn = (...events: EventRow[]) => summariseTurn('t1', events).liveStatus;

    it('defaults to a generic status before anything informative has happened', () => {
      expect(runningTurn()).toBe('thinking…');
    });

    it('reflects the gate deciding to respond', () => {
      expect(runningTurn(ev('gate_evaluated', { verdict: 'respond' }))).toMatch(/composing/);
    });

    it('reflects a tool being invoked right now', () => {
      expect(runningTurn(ev('tool_invoked', { tool: 'web_fetch' }))).toContain('web_fetch');
    });

    it('reflects a tool being blocked by D-022, and that the turn continues', () => {
      const status = runningTurn(ev('tool_call_blocked_untrusted', { tool: 'web_fetch' }));
      expect(status).toContain('web_fetch');
      expect(status).toMatch(/blocked/);
    });

    it('always reads the MOST RECENT event, not the first', () => {
      const status = runningTurn(
        ev('gate_evaluated', { verdict: 'respond' }, 0),
        ev('tool_invoked', { tool: 'document_extract' }, 10),
      );
      expect(status).toContain('document_extract');
    });
  });
});

describe('slash command discovery', () => {
  it('matches on a prefix of the command name', () => {
    expect(matchingCommands('/res')).toHaveLength(1);
    expect(matchingCommands('/research')).toHaveLength(1);
  });

  it('matches nothing once the input diverges from every known command', () => {
    expect(matchingCommands('/xyz')).toHaveLength(0);
  });

  it('does not match text that is not a command at all', () => {
    expect(matchingCommands('hello')).toHaveLength(0);
    expect(matchingCommands('')).toHaveLength(0);
  });

  it('is case-insensitive, matching how the server-side parser treats it', () => {
    expect(matchingCommands('/RESEARCH')).toHaveLength(1);
  });

  it('every listed command names itself correctly in its own usage string', () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.usage.startsWith(c.name)).toBe(true);
    }
  });
});
