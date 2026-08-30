import { describe, it, expect } from 'vitest';
import { resolve, type Candidate } from '@/lib/memory/conflict';
import { audienceContains } from '@/lib/memory/audience';

/**
 * Conflict resolution is deterministic, so it is tested exhaustively.
 *
 * The whole reason it is a function of two dates and two enums — rather than a
 * prompt — is that asking a model which of two conflicting facts it prefers
 * gives different answers on different days. Same inputs, same answer, forever.
 */

const at = (iso: string) => new Date(iso);
const stated = (id: string, iso: string): Candidate => ({ id, sourceType: 'stated', createdAt: at(iso) });
const inferred = (id: string, iso: string): Candidate => ({ id, sourceType: 'inferred', createdAt: at(iso) });

describe('rule 1 — provenance beats recency', () => {
  it('a stated fact supersedes a conflicting inferred one, even an older one', () => {
    const r = resolve(stated('new', '2026-01-01'), inferred('old', '2026-06-01'));
    expect(r).toEqual({ action: 'supersede', supersededId: 'old', tie: false });
  });

  it('a NEWER inference does NOT overturn what the subject said themselves', () => {
    // The case that makes rule 1 worth having: someone said "I moved to
    // Berlin", and a later message has a colleague guessing otherwise.
    const r = resolve(inferred('new', '2026-06-01'), stated('old', '2026-01-01'));
    expect(r.action).toBe('discard');
    if (r.action === 'discard') expect(r.reason).toMatch(/inferred.*cannot overturn.*stated/i);
  });
});

describe('rule 2 — same provenance, recency decides', () => {
  it('a newer stated fact supersedes an older stated one', () => {
    const r = resolve(stated('new', '2026-06-01'), stated('old', '2026-01-01'));
    expect(r).toMatchObject({ action: 'supersede', supersededId: 'old' });
  });

  it('a newer inference supersedes an older inference', () => {
    const r = resolve(inferred('new', '2026-06-01'), inferred('old', '2026-01-01'));
    expect(r).toMatchObject({ action: 'supersede', supersededId: 'old' });
  });

  it('an older fact never overturns a newer one', () => {
    expect(resolve(stated('old', '2026-01-01'), stated('new', '2026-06-01')).action).toBe('discard');
    expect(resolve(inferred('old', '2026-01-01'), inferred('new', '2026-06-01')).action).toBe('discard');
  });
});

describe('rule 3 — a genuine tie is flagged, not hidden', () => {
  it('two directly-stated conflicting facts mark the resolution as a tie', () => {
    // The newer still wins — people change their minds and say so — but this
    // flag is what makes a `memory_conflict` event fire, so a human can see
    // that something was overwritten rather than merged.
    const r = resolve(stated('new', '2026-06-01'), stated('old', '2026-01-01'));
    expect(r).toEqual({ action: 'supersede', supersededId: 'old', tie: true });
  });

  it('a stated-over-inferred win is NOT a tie — the rule decided it cleanly', () => {
    const r = resolve(stated('new', '2026-06-01'), inferred('old', '2026-01-01'));
    expect(r).toMatchObject({ tie: false });
  });

  it('two inferences are not a tie either', () => {
    const r = resolve(inferred('new', '2026-06-01'), inferred('old', '2026-01-01'));
    expect(r).toMatchObject({ tie: false });
  });
});

describe('edge cases', () => {
  it('identical timestamps refuse to choose rather than picking arbitrarily', () => {
    // With no ordering signal, preferring one would be a coin toss dressed up
    // as a rule. Keeping the existing fact is at least stable.
    const r = resolve(stated('a', '2026-01-01'), stated('b', '2026-01-01'));
    expect(r.action).toBe('discard');
    if (r.action === 'discard') expect(r.reason).toMatch(/identical timestamps/i);
  });

  it('an existing item with no id cannot be superseded', () => {
    const r = resolve(stated('new', '2026-06-01'), { sourceType: 'stated', createdAt: at('2026-01-01') });
    expect(r).toEqual({ action: 'keep_both' });
  });

  it('is a pure function — same inputs, same answer', () => {
    const a = stated('new', '2026-06-01');
    const b = inferred('old', '2026-01-01');
    expect(resolve(a, b)).toEqual(resolve(a, b));
  });
});

describe('audience containment in TypeScript', () => {
  /**
   * The authoritative implementation is SQL. This mirror exists so the rule is
   * readable and unit-testable, and it carries the same guard — because the trap
   * is a property of the RULE, not of any one language.
   */
  it('admits a chat whose members are all in the snapshot', () => {
    expect(audienceContains(new Set(['a', 'b', 'c']), ['a', 'b'])).toBe(true);
  });

  it('refuses a chat containing anyone outside the snapshot', () => {
    expect(audienceContains(new Set(['a', 'b']), ['a', 'c'])).toBe(false);
  });

  it('A CHAT WITH ZERO ACTIVE MEMBERS RETURNS FALSE, NOT TRUE', () => {
    // Array.every over an empty array is TRUE, exactly as NOT EXISTS over an
    // empty set is in SQL. Without the explicit guard, a vacated chat would
    // pass containment for every item in the system — the exact leak this
    // project exists to prevent, arriving through its own central rule.
    expect(audienceContains(new Set(['a', 'b']), [])).toBe(false);
    expect(audienceContains(new Set(), [])).toBe(false);
  });

  it('an empty snapshot admits nothing', () => {
    expect(audienceContains(new Set(), ['a'])).toBe(false);
  });
});
