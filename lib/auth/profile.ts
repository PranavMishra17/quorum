import { createClient } from '@/lib/db/server';

/**
 * Per-user colour for message attribution. Deterministic from the user id, so
 * a person is the same colour in every browser and across reloads without
 * storing a choice anywhere.
 */
const PALETTE = [
  '#e06c75', '#d19a66', '#e5c07b', '#98c379',
  '#56b6c2', '#61afef', '#c678dd', '#be5046',
] as const;

function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/**
 * Create the caller's profile row if it does not exist yet.
 *
 * Runs through the SESSION-BOUND client, not the service role, which is
 * deliberate: the `profiles_insert_own` policy already restricts inserts to
 * `id = auth.uid()`, so the database enforces that a user can only ever
 * bootstrap themselves. Using the service role here would work and would quietly
 * remove that guarantee.
 *
 * Idempotent — safe to call on every sign-in.
 */
export async function ensureProfile(): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return;

  const claims = data.claims as {
    sub: string;
    email?: string;
    user_metadata?: { full_name?: string; name?: string; avatar_url?: string };
  };

  const id = claims.sub;
  const meta = claims.user_metadata ?? {};
  const displayName =
    meta.full_name ?? meta.name ?? claims.email?.split('@')[0] ?? 'Someone';

  // ON CONFLICT DO NOTHING semantics: a second sign-in must not overwrite a
  // display name the user has since changed.
  const { error: insertError } = await supabase.from('profiles').insert({
    id,
    display_name: displayName,
    avatar_url: meta.avatar_url ?? null,
    color: colorFor(id),
  });

  // 23505 is unique_violation — the row already existed, which is the normal
  // case on every sign-in after the first.
  if (insertError && insertError.code !== '23505') {
    console.error('[auth] profile bootstrap failed', {
      userId: id,
      code: insertError.code,
    });
  }
}
