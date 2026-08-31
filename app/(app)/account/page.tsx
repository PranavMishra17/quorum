import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';
import { ClearanceStamp } from '@/app/_components/clearance';
import { adminModeEnabled } from '@/lib/auth/admin-mode';
import { CLEARANCES } from '@/config';

export const metadata = { title: 'Account' };

/**
 * Your own record: who you are, what you are cleared for, and where that
 * clearance actually takes you.
 *
 * The ladder is rendered in full, held rungs and unheld alike, because the
 * useful question is not "what do I have" but "what am I missing and what would
 * it open". A list of only your own grants cannot answer that, and answering it
 * is the difference between a profile page and a page that explains the product.
 *
 * Note what is NOT shown: which chats your missing rungs would reveal. That
 * would be a list of rooms you cannot see, which is the disclosure D-027 exists
 * to prevent — the page can say a level exists without saying what is behind it.
 */
export default async function AccountPage() {
  const actor = await requireActor();
  const supabase = await createClient();

  const [{ data: profile }, { data: grants }, { data: memberships }] = await Promise.all([
    supabase.from('profiles').select('display_name, color, created_at').eq('id', actor.id).maybeSingle(),
    supabase
      .from('user_clearances')
      .select('granted_at, clearances(key, name, level)')
      .eq('user_id', actor.id),
    supabase
      .from('chat_members')
      .select('role, status, chats(id, type, name, clearances:required_clearance_id(name, level))')
      .eq('user_id', actor.id),
  ]);

  const me = profile as { display_name: string; color: string; created_at: string } | null;

  const held = ((grants ?? []) as unknown as
    { granted_at: string; clearances: { key: string; name: string; level: number } | null }[]
  )
    .map((g) => ({ ...g.clearances!, granted_at: g.granted_at }))
    .filter((g) => Boolean(g.key))
    .sort((a, b) => a.level - b.level);

  const heldKeys = new Set(held.map((h) => h.key));
  const topLevel = held.length ? Math.max(...held.map((h) => h.level)) : null;

  const rooms = ((memberships ?? []) as unknown as {
    role: 'admin' | 'member';
    status: string;
    chats: {
      id: string; type: 'dm' | 'group' | 'agent'; name: string | null;
      clearances: { name: string; level: number } | null;
    } | null;
  }[])
    .filter((m) => m.chats && m.status === 'member')
    .map((m) => ({ ...m, chat: m.chats! }));

  const groups = rooms.filter((r) => r.chat.type === 'group');
  const dms = rooms.filter((r) => r.chat.type === 'dm');

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start gap-5 border-b border-border pb-6">
        <span
          className="grid h-16 w-16 shrink-0 place-items-center font-display text-2xl font-bold"
          style={{ background: me?.color ?? 'var(--paper)', color: 'var(--on-paper)' }}
          aria-hidden
        >
          {(me?.display_name ?? actor.email ?? '?').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold leading-tight">
            {me?.display_name ?? 'You'}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-muted">{actor.email}</p>
          <p className="label mt-2 text-muted">
            {topLevel === null
              ? 'No clearance held'
              : `Cleared to ${held.find((h) => h.level === topLevel)?.name}`}
          </p>
        </div>
        {topLevel !== null && (
          <ClearanceStamp level={topLevel} name={held.find((h) => h.level === topLevel)?.name} size="md" />
        )}
      </header>

      <section>
        <h2 className="label mb-1 text-foreground">Clearance</h2>
        <p className="mb-4 max-w-2xl text-xs leading-relaxed text-muted">
          One dimension: how sensitive the material is. It says nothing about
          which team you are on — that is what membership is for. A chat is
          readable only if you are a member <em>and</em> hold its level, and both
          are checked on every read.
        </p>
        <ul className="divide-y divide-border border border-border">
          {CLEARANCES.map((rung) => {
            const has = heldKeys.has(rung.key);
            const grant = held.find((h) => h.key === rung.key);
            return (
              <li
                key={rung.key}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${has ? '' : 'opacity-45'}`}
              >
                <ClearanceStamp level={rung.level} name={rung.name} />
                <span className="text-sm">{has ? 'Held' : 'Not held'}</span>
                <span className="ml-auto font-mono text-xs text-muted">
                  {grant ? new Date(grant.granted_at).toLocaleDateString() : '—'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="label mb-3 text-foreground">
          Groups <span className="ml-1 text-muted">{groups.length}</span>
        </h2>
        {groups.length === 0 ? (
          <p className="border border-dashed border-border p-6 text-sm text-muted">
            You are not in any group yet.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {groups.map((g) => (
              <li key={g.chat.id}>
                <Link
                  href={`/chat/${g.chat.id}`}
                  className="flex items-center gap-3 border border-border bg-surface px-4 py-3 transition hover:border-border-strong"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{g.chat.name}</span>
                    {g.role === 'admin' && <span className="label text-muted">Admin</span>}
                  </span>
                  <ClearanceStamp level={g.chat.clearances?.level ?? 0} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="label mb-3 text-foreground">
          Direct messages <span className="ml-1 text-muted">{dms.length}</span>
        </h2>
        <p className="text-xs text-muted">
          {dms.length === 0
            ? 'None yet — click someone in the directory to start one.'
            : `${dms.length} open conversation${dms.length === 1 ? '' : 's'}.`}
        </p>
      </section>

      {adminModeEnabled() && (
        <section className="border-t border-border pt-6">
          <Link
            href="/admin"
            className="label inline-block border border-border-strong px-3 py-2 transition hover:bg-surface-raised"
          >
            Admin mode →
          </Link>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted">
            Development only. Lets you grant yourself any clearance and join any
            group so the authorisation rules can be demonstrated from one
            account. Closed in production.
          </p>
        </section>
      )}
    </div>
  );
}
