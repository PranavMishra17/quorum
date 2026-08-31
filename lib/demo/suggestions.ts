/**
 * Composer suggestion chips for demo and showcase rooms — the one piece of
 * the demo the user is actively guided through, rather than shown.
 *
 * These are plain strings sent through the ORDINARY send path when tapped —
 * `POST /api/chats/:id/messages`, the same idempotency RPC, the same gate, the
 * same everything. A chip is a keyboard shortcut, not a second code path, and
 * that is deliberate: anything demo-specific in the send pipeline would be one
 * more thing a technical reviewer has to check is not secretly propping up the
 * result.
 */

export const DEMO_SUGGESTIONS: Record<string, string[]> = {
  contract: [
    '@quorum I only review contracts on Fridays.',
    '@quorum what does the attached MSA say about the notice period?',
    '@quorum when do I review contracts?',
  ],
  isolation: [
    '@quorum when do I review contracts?',
  ],
  // Showcase rooms (scripts/seed-showcase-accounts.mjs) are ordinary,
  // permanent chats — not `is_demo` — so these are keyed by room name rather
  // than `chats.demo_kind`. See `showcaseSuggestionKind()` below.
  'meridian-deal': [
    '@quorum when does the Meridian exclusivity period end?',
    "@quorum what's the state of the redlines with the other side?",
  ],
  'litigation-support': [
    '@quorum when does the Meridian exclusivity period end?',
    '@quorum what discovery deadlines are open this month?',
  ],
  'showcase-dm': [
    '@quorum when should filings be sent to me?',
  ],
};

/** Maps a showcase room's fixed name to its suggestion key, or null. */
export function showcaseSuggestionKind(roomName: string | null | undefined): string | null {
  if (roomName === 'Meridian Deal Team') return 'meridian-deal';
  if (roomName === 'Litigation Support') return 'litigation-support';
  return null;
}

/** null for anything that is not a demo/showcase chat, or an unrecognised kind. */
export function suggestionsFor(kind: string | null | undefined): string[] | null {
  if (kind && kind in DEMO_SUGGESTIONS) {
    return DEMO_SUGGESTIONS[kind];
  }
  return null;
}
