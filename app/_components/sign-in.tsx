'use client';

import { useState } from 'react';
import { createClient } from '@/lib/db/browser';

interface DevUserOption {
  key: string;
  displayName: string;
  clearance: string | null;
  note: string;
}

export function SignIn({
  devUsers,
  devEnabled,
}: {
  devUsers: DevUserOption[];
  devEnabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <button
        onClick={signInWithGoogle}
        disabled={busy}
        className="w-full rounded-lg border border-border bg-surface-raised px-4 py-3 text-sm font-medium transition hover:border-accent disabled:opacity-50"
      >
        {busy ? 'Redirecting…' : 'Continue with Google'}
      </button>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {devEnabled && (
        <div className="mt-8">
          <div className="mb-3 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wider text-muted">
              Development sign-in
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <p className="mb-4 text-xs leading-relaxed text-muted">
            Demonstrating authorisation needs several identities at once. These
            accounts exist only in development; the route is closed in
            production.
          </p>

          <ul className="space-y-2">
            {devUsers.map((u) => (
              <li key={u.key}>
                <a
                  href={`/auth/dev?user=${u.key}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm transition hover:border-accent"
                >
                  <span className="min-w-0">
                    <span className="block font-medium">{u.displayName}</span>
                    <span className="block truncate text-xs text-muted">
                      {u.note}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded bg-accent-soft px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                      u.clearance ? 'text-accent' : 'text-muted'
                    }`}
                  >
                    {u.clearance ?? 'none'}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
