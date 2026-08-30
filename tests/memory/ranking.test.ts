import { describe, it, expect } from 'vitest';
import { MEMORY } from '@/config';
import { rank, cap, recencyScore } from '@/lib/memory/retrieve';

/**
 * Ranking and capping, tested without a database.
 *
 * These operate on an ALREADY-AUTHORISED set — the filter runs in SQL before a
 * row reaches this code. That is why nothing here can cause a leak: change the
 * weights however you like and the worst outcome is a worse answer, never a
 * wrong audience. The filter is tested against real Postgres, separately.
 */

const NOW = new Date('2026-08-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(over: Partial<Parameters<typeof rank>[0][number]> = {}) {
  return {
    id: 'i1', subject_user_id: 'u1', content: 'a fact',
    clearance_level: 0, source_type: 'stated' as const, confidence: 0.9,
    created_at: daysAgo(0), relevance: 0.5,
    ...over,
  };
}

describe('recency decay', () => {
  it('is 1 for something learned now', () => {
    expect(recencyScore(daysAgo(0), NOW)).toBeCloseTo(1, 5);
  });

  it('is 0.5 at exactly the half-life', () => {
    expect(recencyScore(daysAgo(MEMORY.retrieval.recencyHalfLifeDays), NOW)).toBeCloseTo(0.5, 5);
  });

  it('keeps decaying but never goes negative', () => {
    const far = recencyScore(daysAgo(MEMORY.retrieval.recencyHalfLifeDays * 10), NOW);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(0.01);
  });

  it('treats a future timestamp as fresh rather than as an error', () => {
    // Clock skew between Postgres and the runtime must not produce a negative
    // score that reorders everything.
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(recencyScore(future, NOW)).toBe(1);
  });
});

describe('ranking', () => {
  const opts = { now: NOW, recentSpeakers: new Set<string>() };

  it('orders by combined score, highest first', () => {
    const ranked = rank(
      [row({ id: 'low', relevance: 0.1 }), row({ id: 'high', relevance: 0.9 })],
      opts,
    );
    expect(ranked.map((r) => r.id)).toEqual(['high', 'low']);
  });

  it('prefers a recent fact over an old one of equal relevance', () => {
    const ranked = rank(
      [row({ id: 'old', created_at: daysAgo(365) }), row({ id: 'new', created_at: daysAgo(0) })],
      opts,
    );
    expect(ranked[0].id).toBe('new');
  });

  it('boosts a fact about someone who just spoke', () => {
    const ranked = rank(
      [row({ id: 'quiet', subject_user_id: 'u2' }), row({ id: 'speaking', subject_user_id: 'u1' })],
      { now: NOW, recentSpeakers: new Set(['u1']) },
    );
    expect(ranked[0].id).toBe('speaking');
  });

  it('speaker presence alone does not outrank a far more relevant fact', () => {
    // The weights are 0.6 relevance / 0.2 recency / 0.2 presence, so presence
    // is a tiebreaker rather than an override. Worth pinning: a config change
    // that inverted this would be hard to notice by eye.
    const ranked = rank(
      [
        row({ id: 'relevant', subject_user_id: 'u2', relevance: 1 }),
        row({ id: 'present', subject_user_id: 'u1', relevance: 0 }),
      ],
      { now: NOW, recentSpeakers: new Set(['u1']) },
    );
    expect(ranked[0].id).toBe('relevant');
  });

  it('produces a score in [0,1] for inputs in [0,1]', () => {
    const [only] = rank([row({ relevance: 1, created_at: daysAgo(0) })], {
      now: NOW, recentSpeakers: new Set(['u1']),
    });
    expect(only.score).toBeGreaterThan(0);
    expect(only.score).toBeLessThanOrEqual(1.0000001);
  });
});

describe('capping', () => {
  const ranked = (items: { id: string; subject: string }[]) =>
    items.map((i) => ({
      id: i.id, subjectUserId: i.subject, content: 'x',
      sourceType: 'stated' as const, confidence: 1, createdAt: daysAgo(0), score: 1,
    }));

  it('enforces the global budget', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, subject: `u${i}` }));
    const { kept } = cap(ranked(many));
    expect(kept.length).toBe(MEMORY.retrieval.globalItemCap);
  });

  it('enforces the per-subject cap so one person cannot crowd out the rest', () => {
    // The twenty-person-group problem: without this, the most-discussed member
    // fills the entire budget and the other nineteen are invisible.
    const hogged = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, subject: 'loud' }));
    const { kept } = cap(ranked(hogged));
    expect(kept.length).toBe(MEMORY.retrieval.perSubjectCap);
  });

  it('lets other subjects through once one has hit their cap', () => {
    const mixed = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `loud${i}`, subject: 'loud' })),
      { id: 'quiet1', subject: 'quiet' },
    ];
    const { kept } = cap(ranked(mixed));
    expect(kept.some((k) => k.id === 'quiet1')).toBe(true);
    expect(kept.filter((k) => k.subjectUserId === 'loud').length)
      .toBe(MEMORY.retrieval.perSubjectCap);
  });

  it('reports how many the caps removed, separately from the filter', () => {
    // Budget and authorisation must never be reported as the same number —
    // conflating them would make the internal view's filtered-out count a lie.
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, subject: `u${i}` }));
    const { kept, cappedOut } = cap(ranked(many));
    expect(kept.length + cappedOut).toBe(30);
  });

  it('keeps the highest-ranked items, not an arbitrary slice', () => {
    const items = [
      { id: 'best', subjectUserId: 'a', content: 'x', sourceType: 'stated' as const, confidence: 1, createdAt: daysAgo(0), score: 0.9 },
      { id: 'worst', subjectUserId: 'b', content: 'x', sourceType: 'stated' as const, confidence: 1, createdAt: daysAgo(0), score: 0.1 },
    ];
    const { kept } = cap(items);
    expect(kept[0].id).toBe('best');
  });

  it('returns nothing for nothing', () => {
    expect(cap([])).toEqual({ kept: [], cappedOut: 0 });
  });
});
