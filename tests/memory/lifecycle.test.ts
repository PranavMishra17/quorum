import { describe, it } from 'vitest';

/**
 * Memory lifecycle and conflict resolution.
 *
 * Conflict resolution is deterministic by design — the model is never asked
 * which of two conflicting facts it prefers, because that answer is not
 * reproducible and therefore not testable. These tests are what that decision
 * buys: every one of them has exactly one correct answer.
 */
describe('memory lifecycle', () => {
  describe('status gates retrieval', () => {
    it.todo('a candidate item below the confidence threshold is never retrieved');
    it.todo('an item is promoted from candidate to active once accepted');
    it.todo('a superseded item is not retrieved');
    it.todo('an item past its expires_at is treated as stale and not retrieved');
    it.todo('only active items are eligible for retrieval');
  });

  describe('conflict resolution is deterministic', () => {
    it.todo('a directly stated fact supersedes a conflicting inferred fact');
    it.todo(
      'a newer stated fact supersedes an older stated fact about the same subject',
    );
    it.todo('an older stated fact is NOT superseded by a newer inferred fact');
    it.todo('superseded_by points at the item that displaced it');
    it.todo('a genuine tie writes a memory_conflict event rather than resolving silently');
    it.todo('resolving the same conflict twice produces the same outcome');
  });

  describe('provenance', () => {
    it.todo('every item records the chat and message it was learned from');
    it.todo('an item asserted by a third party is stored as inferred, not stated');
    it.todo('extraction never widens the audience beyond the originating chat');
  });

  describe('extraction is deferred', () => {
    it.todo('extraction does not run inside the response request path');
    it.todo('a failed extraction does not fail the user-visible turn');
    it.todo('extraction is capped at maxItemsPerTurn');
  });
});
