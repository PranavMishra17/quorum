import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActor, createClient } from '@/lib/db/server';
import { SignOut } from '../_components/sign-out';
import { ClearanceStamp } from '../_components/clearance';
import { FloatingPanelsProvider } from '../_components/floating-panels/context';
import { FloatingPanelHost } from '../_components/floating-panels/host';
import { adminModeEnabled } from '@/lib/auth/admin-mode';

/**
 * The authenticated shell.
 *
 * This redirect is UX, not a guard. If it were removed, a signed-out visitor
 * would reach the chat UI and see nothing at all, because every query behind it
 * returns nothing under row-level security. That is the test of whether an
 * authorisation story is real: remove the convenience layer and check that the
 * data still refuses to come out.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/');

  const supabase = await createClient();
  const [{ data: profile }, { data: clearances }] = await Promise.all([
    supabase.from('profiles').select('display_name, color').eq('id', actor.id).maybeSingle(),
    supabase.from('user_clearances').select('clearances(key, name, level)').eq('user_id', actor.id),
  ]);

  const held = ((clearances ?? []) as unknown as
    { clearances: { name: string; level: number } | null }[]
  )
    .map((r) => r.clearances)
    .filter((c): c is { name: string; level: number } => Boolean(c))
    .sort((a, b) => b.level - a.level);

  const me = profile as { display_name: string; color: string } | null;
  const top = held[0] ?? null;

  return (
    <FloatingPanelsProvider>
      <div className="flex min-h-full flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-5 px-5 py-3">
            <Link href="/chats" className="font-display text-base font-bold tracking-tight">
              QUORUM
            </Link>

            <nav className="flex items-center gap-4">
              <NavLink href="/chats">Workspace</NavLink>
              <NavLink href="/people">Rooms</NavLink>
              <NavLink href="/connectors">Capabilities</NavLink>
              <NavLink href="/memory">Memory</NavLink>
              <NavLink href="/usage">Usage</NavLink>
              {adminModeEnabled() && (
                <Link
                  href="/admin"
                  className="label border px-2 py-1 transition hover:bg-surface-raised"
                  style={{ color: 'var(--c3)', borderColor: 'var(--c3)' }}
                >
                  Admin
                </Link>
              )}
            </nav>

            <div className="ml-auto flex items-center gap-3">
              {/* Always visible: the whole product hinges on the reader knowing
                  what they are cleared for before they wonder why a room is
                  missing. */}
              {top ? (
                <ClearanceStamp level={top.level} name={top.name} />
              ) : (
                <span className="label text-muted">No clearance</span>
              )}
              <Link
                href="/account"
                title={me?.display_name ?? actor.email ?? 'Your account'}
                className="grid h-7 w-7 place-items-center text-xs font-semibold"
                style={{ background: me?.color ?? 'var(--paper)', color: 'var(--on-paper)' }}
              >
                {(me?.display_name ?? actor.email ?? '?').charAt(0).toUpperCase()}
              </Link>
              <SignOut />
            </div>
          </div>
        </header>

        <div className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</div>
      </div>
      <FloatingPanelHost />
    </FloatingPanelsProvider>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="label hidden text-muted transition hover:text-foreground sm:inline-block"
    >
      {children}
    </Link>
  );
}
