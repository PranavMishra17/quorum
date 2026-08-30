/**
 * The seeded development cast.
 *
 * Chosen so that a single glance at the chat list demonstrates both
 * authorisation axes and the memory surfacing rule:
 *
 *   - Dana holds no clearance at all, so she is a *member* of the gated chat
 *     and still cannot read it. That is the axis-independence demo: membership
 *     without clearance grants nothing.
 *   - Alice and Bob share BOTH a confidential chat and a general chat with an
 *     identical member set, and are cleared for both. That is the case that
 *     makes the clearance floor non-redundant: audience containment holds in
 *     both directions, so only the floor stops a deal-room fact surfacing in
 *     the general room.
 *   - Erin is in nothing, so she is the "third session sees nothing" control.
 */

export interface DevUser {
  key: string;
  email: string;
  displayName: string;
  /** Clearance key from config/agent.ts, or null for none. */
  clearance: string | null;
  note: string;
}

export const DEV_USERS: readonly DevUser[] = [
  { key: 'alice', email: 'alice@quorum.dev', displayName: 'Alice Nakamura',
    clearance: 'restricted',   note: 'Top of the ladder. Admin of most chats.' },
  { key: 'bob',   email: 'bob@quorum.dev',   displayName: 'Bob Oyelaran',
    clearance: 'confidential', note: 'Cleared for confidential, not restricted.' },
  { key: 'carol', email: 'carol@quorum.dev', displayName: 'Carol Whitfield',
    clearance: 'internal',     note: 'Internal only.' },
  { key: 'dana',  email: 'dana@quorum.dev',  displayName: 'Dana Iqbal',
    clearance: null,           note: 'No clearance. Member of a gated chat she cannot read.' },
  { key: 'erin',  email: 'erin@quorum.dev',  displayName: 'Erin Vasquez',
    clearance: 'general',      note: 'In no chats. The "sees nothing" control.' },
] as const;

/**
 * Shared password for the seeded accounts. Not a secret — these accounts exist
 * only in a development project, and the route that uses them is closed in
 * production by `devLoginEnabled()`. If this ever needs to be a secret, the
 * feature is being used somewhere it should not be.
 */
export const DEV_PASSWORD = 'quorum-dev-password-not-a-secret';

/**
 * Three independent conditions, all of which must hold.
 *
 * Opt-in rather than opt-out: a missing ALLOW_DEV_LOGIN disables the route, so
 * forgetting to set something can never be what opens it.
 */
export function devLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_DEV_LOGIN === 'true'
  );
}
