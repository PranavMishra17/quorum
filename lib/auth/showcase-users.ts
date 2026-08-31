/**
 * The two fixed showcase identities offered on the landing page.
 *
 * Deliberately not `lib/auth/dev-users.ts`: that list is closed in production
 * by three independent gates (`devLoginEnabled()`), because signing in as any
 * of five accounts with no password is the kind of thing that should require
 * an explicit opt-in on a real deployment. This list is the opposite choice,
 * made on purpose (see the question this was raised against in chat) — always
 * on, exactly two named accounts, so a reviewer on the live URL can see a
 * rich, multi-room world with zero setup.
 *
 * That is a smaller exposure than it sounds. RLS is not bypassed or narrowed
 * for these accounts — they are ordinary authenticated users, same as anyone
 * who signs in with Google. The only rooms they can affect are their own
 * seeded rooms, and the only other members of those rooms are also seeded
 * identities (never a real user), so there is no real account this can reach.
 */
export interface ShowcaseUser {
  key: string;
  email: string;
}

export const SHOWCASE_USERS: ShowcaseUser[] = [
  { key: 'jordan', email: 'jordan.demo@quorum.dev' },
  { key: 'morgan', email: 'morgan.demo@quorum.dev' },
];

/**
 * Closed by absence, not by environment: with no password configured there is
 * nothing to sign in with, so a fresh clone leaves the route dead rather than
 * throwing. Never printed, never sent to the client.
 */
export function showcaseAccountPassword(): string | null {
  return process.env.SHOWCASE_ACCOUNT_PASSWORD?.trim() || null;
}
