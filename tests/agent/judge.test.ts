import { describe, it, expect } from 'vitest';
import { judge, type JudgeInput } from '@/lib/agent/judge';
import { LlmError } from '@/lib/llm/errors';
import type { LlmProvider, StructuredParams, StructuredResult } from '@/lib/llm/provider';

/**
 * The judge is tested for its CONTRACT, not for its taste.
 *
 * What is provable in this budget: which shape it returns, that the schema is
 * enforced, and that every failure path resolves to silence. Whether it makes
 * good calls on ambiguous input is a genuinely hard evaluation problem needing
 * a labelled corpus, and claiming otherwise in a README would be dishonest.
 *
 * The provider is stubbed, so no API key is involved.
 */

function stubProvider(
  impl: (p: StructuredParams<unknown>) => Promise<unknown>,
): LlmProvider {
  return {
    complete: async () => { throw new Error('not used'); },
    structured: async <T>(p: StructuredParams<T>): Promise<StructuredResult<T>> => {
      const value = await impl(p as StructuredParams<unknown>);
      if (!p.validate(value)) {
        throw new LlmError('malformed_output', 'stub produced an invalid value');
      }
      return {
        text: JSON.stringify(value), value, model: 'stub', stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

const INPUT: JudgeInput = {
  chatName: 'Engineering',
  memberCount: 4,
  transcript: [
    { speaker: 'Alice', content: 'Does anyone know why the deploy failed?', isAgent: false },
    { speaker: 'Bob', content: 'No idea.', isAgent: false },
  ],
};

describe('the happy path', () => {
  it('passes a respond verdict through with its reason', async () => {
    const p = stubProvider(async () => ({ verdict: 'respond', reason: 'A direct question nobody answered.' }));
    const d = await judge(p, INPUT);
    expect(d).toEqual({
      verdict: 'respond', rule: 'judge', reason: 'A direct question nobody answered.',
    });
  });

  it('passes a silent verdict through', async () => {
    const p = stubProvider(async () => ({ verdict: 'silent', reason: 'They are talking to each other.' }));
    const d = await judge(p, INPUT);
    expect(d).toMatchObject({ verdict: 'silent', rule: 'judge' });
  });

  it('asks on the judge tier, not the conversational one', async () => {
    let seen: string | undefined;
    const p = stubProvider(async (params) => {
      seen = params.purpose;
      return { verdict: 'silent', reason: 'nothing to add' };
    });
    await judge(p, INPUT);
    expect(seen).toBe('gate_judge');
  });

  it('constrains the response to a discrete enum, not a score', async () => {
    let schema: Record<string, unknown> | undefined;
    const p = stubProvider(async (params) => {
      schema = params.schema as Record<string, unknown>;
      return { verdict: 'silent', reason: 'x' };
    });
    await judge(p, INPUT);
    const props = (schema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.verdict.enum).toEqual(['respond', 'silent']);
    expect(JSON.stringify(schema)).not.toMatch(/confidence|score|probability/i);
  });

  it('shows the model the transcript it is judging', async () => {
    let prompt = '';
    const p = stubProvider(async (params) => {
      prompt = String(params.messages[0].content);
      return { verdict: 'silent', reason: 'x' };
    });
    await judge(p, INPUT);
    expect(prompt).toContain('Does anyone know why the deploy failed?');
    expect(prompt).toContain('Engineering');
  });
});

describe('every failure resolves to SILENCE', () => {
  const failures: [string, unknown][] = [
    ['timeout', new LlmError('timeout', 'wall clock exceeded')],
    ['refusal', new LlmError('refusal', 'declined')],
    ['rate limit', new LlmError('rate_limited', 'slow down')],
    ['spend cap', new LlmError('spend_cap_reached', 'no credit')],
    ['dead key', new LlmError('authentication', 'invalid key')],
    ['server error', new LlmError('server_error', 'boom')],
    ['a plain throw', new Error('something unexpected')],
  ];

  it.each(failures)('%s → silent', async (_label, error) => {
    const p = stubProvider(async () => { throw error; });
    const d = await judge(p, INPUT);
    expect(d.verdict).toBe('silent');
    expect(d.rule).toBe('judge_failed');
  });

  it('malformed output → silent, not a crash and not a guess', async () => {
    const p = stubProvider(async () => ({ verdict: 'maybe', reason: 'unsure' }));
    const d = await judge(p, INPUT);
    expect(d.verdict).toBe('silent');
    expect(d.rule).toBe('judge_failed');
  });

  it('a missing reason is rejected — the internal view needs one', async () => {
    const p = stubProvider(async () => ({ verdict: 'respond' }));
    const d = await judge(p, INPUT);
    expect(d.verdict).toBe('silent');
  });

  it('an empty reason is rejected', async () => {
    const p = stubProvider(async () => ({ verdict: 'respond', reason: '' }));
    expect((await judge(p, INPUT)).verdict).toBe('silent');
  });

  it('records WHY it was silent, so the gap is not mistaken for a decision', async () => {
    const p = stubProvider(async () => { throw new LlmError('timeout', 'x'); });
    const d = await judge(p, INPUT);
    expect(d.reason).toMatch(/judge unavailable/i);
    expect(d.reason).toMatch(/silence/i);
  });

  it('never throws — a broken judge must not take the turn down', async () => {
    const p = stubProvider(async () => { throw new LlmError('server_error', 'x'); });
    await expect(judge(p, INPUT)).resolves.toBeDefined();
  });
});

describe('the prompt biases toward silence', () => {
  it('tells the model silence is the default and mentions the escape hatch', async () => {
    let system = '';
    const p = stubProvider(async (params) => {
      system = params.system ?? '';
      return { verdict: 'silent', reason: 'x' };
    });
    await judge(p, INPUT);
    // Whitespace-tolerant: the prompt is hard-wrapped for readability, so a
    // literal-space regex would fail on a line break rather than on meaning.
    const flat = system.replace(/\s+/g, ' ');
    expect(flat).toMatch(/silence is the default/i);
    // Why declining is safe: a mention bypasses the judge entirely (rule 3).
    expect(flat).toMatch(/address you by name/i);
    expect(flat).toMatch(/not deciding what to say/i);
  });
});
