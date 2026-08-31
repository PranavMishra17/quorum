import { describe, it, expect } from 'vitest';
import { isRetrievable, withheldReason, type MyMemoryItem } from '@/lib/memory/mine';

/**
 * The subject-access side of memory: `isRetrievable` and `withheldReason` are
 * the two pure functions the Memory page renders through. `my_memory()` itself
 * is exercised in `tests/authorization/my-memory.test.ts` against a real
 * Postgres, as an unprivileged role — the two together are what let this page
 * claim "everything the agent has recorded about you" without the claim being
 * an accident of what happened to be fetched.
 */

const item = (over: Partial<MyMemoryItem> = {}): MyMemoryItem => ({
  id: 'i1',
  content: 'reviews contracts on Fridays',
  sourceType: 'stated',
  status: 'active',
  confidence: 0.9,
  clearanceLevel: 0,
  originChatId: 'c1',
  audienceSize: 2,
  createdAt: new Date().toISOString(),
  expiresAt: null,
  supersededBy: null,
  ...over,
});

describe('isRetrievable', () => {
  it('an active item with no expiry is in use', () => {
    expect(isRetrievable(item())).toBe(true);
  });

  it('a candidate is never in use, regardless of confidence', () => {
    expect(isRetrievable(item({ status: 'candidate', confidence: 0.99 }))).toBe(false);
  });

  it('a superseded item is never in use, even if nothing else changed', () => {
    expect(isRetrievable(item({ status: 'superseded' }))).toBe(false);
  });

  it('a stale item is never in use', () => {
    expect(isRetrievable(item({ status: 'stale' }))).toBe(false);
  });

  it('an active item past its own expiry is not in use', () => {
    // Belt and braces: the lifecycle job should have already flipped this to
    // stale, but the page must not show an expired fact as live if it has not.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(isRetrievable(item({ status: 'active', expiresAt: yesterday }))).toBe(false);
  });

  it('an active item with a future expiry is still in use', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(isRetrievable(item({ status: 'active', expiresAt: tomorrow }))).toBe(true);
  });
});

describe('withheldReason', () => {
  it('is null for something in use — no reason to give', () => {
    expect(withheldReason(item())).toBeNull();
  });

  it('explains a candidate without implying it was rejected outright', () => {
    const reason = withheldReason(item({ status: 'candidate' }));
    expect(reason).toMatch(/recorded/i);
    expect(reason).toMatch(/never used/i);
  });

  it('explains supersession without saying the fact was wrong', () => {
    expect(withheldReason(item({ status: 'superseded' }))).toMatch(/replaced/i);
  });

  it('explains staleness distinctly from an expired-but-still-active row', () => {
    const stale = withheldReason(item({ status: 'stale' }));
    const expired = withheldReason(
      item({ status: 'active', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(stale).toMatch(/expired/i);
    expect(expired).toMatch(/expiry/i);
    expect(stale).not.toBe(expired);
  });
});
