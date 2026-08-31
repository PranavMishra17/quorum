import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';
import { adminModeEnabled } from '@/lib/auth/admin-mode';
import { AdminControls, type AdminRung, type AdminGroup } from '@/app/_components/admin-controls';

export const metadata = { title: 'Admin mode' };

/**
 * Admin mode — grant yourself a clearance, join a group, and watch the rules
 * respond.
 *
 * `notFound()` rather than a "not authorised" page: a feature that is switched
 * off should not confirm it is a feature. Same reasoning as the dev-login route.
 *
 * This page renders controls; it holds no privilege. Every action posts to
 * `/api/admin`, which is the only place the arming secret exists, and the
 * database refuses regardless unless `private.admin_mode_secret` has been
 * deliberately populated. See migration 0016 for why an env-var gate alone
 * would not have been enough.
 */
export default async function AdminPage() {
  if (!adminModeEnabled()) notFound();

  const actor = await requireActor();
  const supabase = await createClient();

  const [{ data: ladder }, { data: mine }, { data: chats }, { data: memberships }, { data: log }] =
    await Promise.all([
      supabase.from('clearances').select('id, key, name, level').order('level'),
      supabase.from('user_clearances').select('clearance_id').eq('user_id', actor.id),
      supabase.from('chats').select('id, name, type').eq('type', 'group'),
      supabase.from('chat_members').select('chat_id, status').eq('user_id', actor.id),
      supabase
        .from('admin_mode_log')
        .select('id, action, target_id, created_at')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

  const held = new Set(
    ((mine ?? []) as unknown as { clearance_id: string }[]).map((r) => r.clearance_id),
  );
  const memberOf = new Map(
    ((memberships ?? []) as unknown as { chat_id: string; status: string }[]).map((m) => [
      m.chat_id,
      m.status,
    ]),
  );

  const rungs: AdminRung[] = ((ladder ?? []) as unknown as
    { id: string; key: string; name: string; level: number }[]
  ).map((r) => ({ ...r, held: held.has(r.id) }));

  /**
   * Note what this list can and cannot contain: only groups the viewer can
   * already SEE. Admin mode raises what you hold; it does not hand you a
   * directory of rooms the rules currently hide. So the demo loop is
   * deliberately two steps — grant yourself the clearance, watch a room appear,
   * then join it — which is a better demonstration than a god-list would be,
   * because each step is the rule working.
   */
  const groups: AdminGroup[] = ((chats ?? []) as unknown as
    { id: string; name: string | null }[]
  ).map((c) => ({
    id: c.id,
    name: c.name ?? 'Untitled group',
    member: memberOf.get(c.id) === 'member',
  }));

  const history = (log ?? []) as unknown as {
    id: string; action: string; target_id: string; created_at: string;
  }[];

  const nameFor = new Map<string, string>([
    ...rungs.map((r) => [r.id, r.name] as const),
    ...groups.map((g) => [g.id, g.name] as const),
  ]);

  return (
    <div className="space-y-8">
      <header className="border-b border-border pb-5">
        <span className="label" style={{ color: 'var(--c3)' }}>
          Development only
        </span>
        <h1 className="mt-2 font-display text-2xl font-semibold">Admin mode</h1>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted">
          Grant yourself a clearance or join a group, so the two authorisation
          axes can be demonstrated from one account instead of three. This does
          not bypass anything — it changes what you <em>hold</em>, and every read
          afterwards runs the same policies as anyone else&apos;s. Every action
          below is recorded, so a self-issued clearance can be told apart from a
          granted one.
        </p>
      </header>

      <AdminControls rungs={rungs} groups={groups} />

      <section>
        <h2 className="label mb-3 text-foreground">What you gave yourself</h2>
        {history.length === 0 ? (
          <p className="border border-dashed border-border p-6 text-xs text-muted">
            Nothing yet. This log is written by the database function itself, not
            by the page, so it cannot be skipped.
          </p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {history.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className="label w-14 shrink-0 text-muted">{h.action}</span>
                <span className="min-w-0 flex-1 truncate">
                  {nameFor.get(h.target_id) ?? h.target_id}
                </span>
                <span className="shrink-0 font-mono text-muted">
                  {new Date(h.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link href="/account" className="inline-block text-xs underline underline-offset-4">
        Back to your account
      </Link>
    </div>
  );
}
