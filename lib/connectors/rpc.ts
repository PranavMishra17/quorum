import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Reach a table or function that a NEW migration adds but the generated types
 * do not know about yet.
 *
 * `lib/db/types.ts` is `supabase gen types --linked` output: it describes the
 * schema of the LINKED PROJECT, not of the migrations in this repo. So every
 * new migration has a window between "written and tested" and "pushed and
 * regenerated" in which the types lag the schema by exactly one file.
 *
 * The alternatives were worse. Hand-editing `types.ts` puts a lie in a
 * generated file that the next regeneration silently reverts. Scattering
 * `as never` across three call sites hides the reason behind a cast that reads
 * like ordinary type noise. This is one function with one explanation, and
 * deleting it is the checklist item after the next regeneration:
 *
 *   pnpm supabase db push
 *   pnpm supabase gen types typescript --linked > lib/db/types.ts
 *   # then delete this file and its imports
 *
 * Currently covering: `connector_tokens` and its RPCs (0014), and
 * `admin_mode_log` and the `dev_self_*` RPCs (0016).
 *
 * It weakens typing at those call sites only. The migration is the source of
 * truth either way, and the real check is that `tests/` runs every migration
 * against a real Postgres — which catches a wrong table or function name far
 * more decisively than a generated type would.
 */
export function untypedDb<T>(client: SupabaseClient<T>): SupabaseClient {
  return client as unknown as SupabaseClient;
}
