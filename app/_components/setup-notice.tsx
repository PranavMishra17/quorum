/**
 * Shown when `NEXT_PUBLIC_SUPABASE_*` is missing.
 *
 * A fresh clone with no `.env.local` is an ordinary state, not an exception —
 * and a stack trace saying "Invalid or missing public environment variables" is
 * a worse answer than telling someone which five minutes of setup they are
 * missing. Nothing in the app can work without a database, so this is the whole
 * page rather than a banner.
 */
export function SetupNotice() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div>
        <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted">Quorum</p>
        <h1 className="text-2xl font-semibold">Not configured yet</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The app needs a Supabase project. Everything below the UI —
          authorisation, memory isolation, the audit trail — lives in Postgres
          row-level security, so there is nothing meaningful to show without a
          database. This takes about ten minutes.
        </p>
      </div>

      <ol className="space-y-4 border-l-2 border-border pl-5 text-sm">
        <li>
          <strong>Create a Supabase project</strong>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Follow <code className="text-foreground">docs/SETUP-SUPABASE.md</code>.
            It lists the exact dashboard pages and the three values you need.
          </p>
        </li>
        <li>
          <strong>Fill in the environment</strong>
          <pre className="scroll-x mt-1 border border-border bg-surface p-3 text-xs">
{`cp .env.example .env.local
# then paste the Supabase URL, publishable key, secret key,
# and your Anthropic key`}
          </pre>
        </li>
        <li>
          <strong>Apply the migrations</strong>
          <pre className="scroll-x mt-1 border border-border bg-surface p-3 text-xs">
{`pnpm supabase link --project-ref YOUR-REF
pnpm supabase db push`}
          </pre>
        </li>
        <li>
          <strong>Seed a workspace to click around</strong>
          <pre className="scroll-x mt-1 border border-border bg-surface p-3 text-xs">
{`pnpm seed:dev`}
          </pre>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            ~55 people and 14 groups, arranged so the authorisation model is
            visible by clicking rather than by being explained. Set{' '}
            <code>ALLOW_DEV_LOGIN=true</code> and sign in as any of them without
            Google.
          </p>
        </li>
      </ol>

      <p className="text-xs leading-relaxed text-muted">
        The test suite needs none of this — it runs its own PostgreSQL.{' '}
        <code className="text-foreground">pnpm test</code> works on a fresh clone.
      </p>
    </main>
  );
}
