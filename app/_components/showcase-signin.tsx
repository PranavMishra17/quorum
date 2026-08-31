import { createClient } from '@/lib/db/server';

interface ShowcaseProfile {
  showcase_key: string;
  display_name: string;
  color: string;
  showcase_title: string | null;
  showcase_note: string | null;
}

/**
 * "Sign in as a showcase account" — the prominent option, not the buried one.
 *
 * Reads through the ordinary session-bound client with no session, so this
 * query runs as the `anon` Postgres role and is answered by exactly one
 * narrow policy (`profiles_select_anon_showcase`, migration 0021) scoped to
 * `is_showcase = true`. If the accounts have not been seeded yet
 * (`pnpm seed:showcase`), the query returns nothing and this renders nothing —
 * absence is silent, the same way a missing `SHOWCASE_ACCOUNT_PASSWORD` 404s
 * the sign-in route instead of erroring.
 */
export async function ShowcaseSignIn() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('profiles')
    .select('showcase_key, display_name, color, showcase_title, showcase_note')
    .eq('is_showcase', true)
    .order('showcase_key');

  const people = (data ?? []) as unknown as ShowcaseProfile[];
  if (people.length === 0) return null;

  return (
    <div className="mb-6 border border-border-strong bg-surface-raised p-5">
      <h2 className="label mb-1 text-foreground">Explore a live account</h2>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        Two standing accounts, each with several rooms, real history, and
        memory already built up — no setup, one click.
      </p>
      <ul className="space-y-2">
        {people.map((p) => (
          <li key={p.showcase_key}>
            <a
              href={`/auth/showcase?user=${p.showcase_key}`}
              className="flex items-center gap-3 border border-border bg-surface px-3 py-2.5 transition hover:border-border-strong"
            >
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-background"
                style={{ background: p.color }}
                aria-hidden
              >
                {p.display_name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{p.display_name}</span>
                  {p.showcase_title && (
                    <span className="truncate text-xs text-muted">{p.showcase_title}</span>
                  )}
                </span>
                {p.showcase_note && (
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {p.showcase_note}
                  </span>
                )}
              </span>
              <span className="label shrink-0 text-foreground">Enter →</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
