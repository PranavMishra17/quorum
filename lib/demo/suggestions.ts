/**
 * Composer suggestion chips for demo rooms — the one piece of the demo the
 * user is actively guided through, rather than shown.
 *
 * These are plain strings sent through the ORDINARY send path when tapped —
 * `POST /api/chats/:id/messages`, the same idempotency RPC, the same gate, the
 * same everything. A chip is a keyboard shortcut, not a second code path, and
 * that is deliberate: anything demo-specific in the send pipeline would be one
 * more thing a technical reviewer has to check is not secretly propping up the
 * result.
 */

export const DEMO_SUGGESTIONS: Record<'contract' | 'isolation', string[]> = {
  contract: [
    '@quorum I only review contracts on Fridays.',
    '@quorum what does the attached MSA say about the notice period?',
    '@quorum when do I review contracts?',
  ],
  isolation: [
    '@quorum when do I review contracts?',
  ],
};

/** null for anything that is not a demo chat, or an unrecognised kind. */
export function suggestionsFor(demoKind: string | null | undefined): string[] | null {
  if (demoKind === 'contract' || demoKind === 'isolation') {
    return DEMO_SUGGESTIONS[demoKind];
  }
  return null;
}
