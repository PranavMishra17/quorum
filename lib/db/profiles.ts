import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

/**
 * Look up display names and colours for a set of user ids.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A POSTGREST EMBED
 *
 * The obvious form is `.select('user_id, profiles:user_id(display_name)')`, and
 * it does not work: `chat_members.user_id` references **`auth.users`**, not
 * `public.profiles`, so PostgREST has no foreign key to resolve the embed
 * through and returns
 *
 *   Could not find a relationship between 'chat_members' and 'user_id'
 *
 * The failure mode is what made this worth a module. Pages destructured only
 * `{ data }` and discarded `error`, so a query that FAILED returned an empty
 * array — indistinguishable from a query that found nothing. The chat page
 * concluded its own author was not a member of their own DM and rendered
 * "You are not a member of this chat."
 *
 * It was caught by `pnpm verify:live` driving a real browser, and it could not
 * have been caught by the database suite: every policy involved was correct.
 * The application was asking the wrong question and ignoring the answer.
 *
 * The alternative fix is a second foreign key from `chat_members.user_id` to
 * `profiles.id`, which would make the embed resolve. That is arguably the
 * better data model — chat members really are profiles — but it adds a
 * constraint that fails for any user without a profile row, and an explicit
 * query costs one round trip and cannot silently degrade.
 */
export async function namesFor(
  supabase: SupabaseClient<Database>,
  userIds: readonly string[],
): Promise<Map<string, { name: string; color: string }>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, color')
    .in('id', ids);

  if (error) {
    // Loud, because a silent failure here renders everyone as "Someone" and
    // looks like a data problem rather than a query problem.
    console.error('[profiles] lookup failed', { code: error.code, message: error.message });
    return new Map();
  }

  return new Map(
    (data ?? []).map((p) => [p.id, { name: p.display_name, color: p.color }]),
  );
}
