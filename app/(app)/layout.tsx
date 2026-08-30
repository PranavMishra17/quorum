import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActor, createClient } from '@/lib/db/server';
import { SignOut } from '../_components/sign-out';

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
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, color')
    .eq('id', actor.id)
    .maybeSingle();

  const { data: clearances } = await supabase
    .from('user_clearances')
    .select('clearances(key, name, level)')
    .eq('user_id', actor.id);

  const held = ((clearances ?? []) as unknown as { clearances: { name: string; level: number } | null }[])
    .map((r) => r.clearances)
    .filter((c): c is { name: string; level: number } => Boolean(c))
    .sort((a, b) => b.level - a.level);

  const me = profile as { display_name: string; color: string } | null;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3">
          <Link href="/chats" className="text-sm font-semibold tracking-tight">
            Quorum
          </Link>

          <div className="ml-auto flex items-center gap-3">
            {/* The clearance badge is deliberately always visible: the whole
                product hinges on the reader knowing what they are cleared for. */}
            <span className="hidden text-xs text-muted sm:inline">
              {held.length > 0 ? held[0].name : 'No clearance'}
            </span>
            <span
              className="grid h-7 w-7 place-items-center rounded-full text-xs font-medium text-background"
              style={{ background: me?.color ?? 'var(--accent)' }}
              title={me?.display_name ?? actor.email ?? ''}
            >
              {(me?.display_name ?? actor.email ?? '?').charAt(0).toUpperCase()}
            </span>
            <SignOut />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</div>
    </div>
  );
}
