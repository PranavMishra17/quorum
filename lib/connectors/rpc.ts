import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Call a function that migration 0014 adds but the generated types do not know
 * about yet.
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
 *   # then remove this file and the three imports of it
 *
 * It weakens typing for these calls only. The migration is the source of truth
 * either way, and the real check is that `tests/` runs the migrations against a
 * real Postgres — which catches a wrong function name far more decisively than
 * a generated type would.
 */
export function untypedRpc<T>(client: SupabaseClient<T>): SupabaseClient {
  return client as unknown as SupabaseClient;
}
