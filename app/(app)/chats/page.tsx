import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';
import { NewChat, type Person, type ClearanceOption } from '@/app/_components/new-chat';
import { PopOutButton } from '@/app/_components/floating-panels/pop-out-button';
import { namesFor } from '@/lib/db/profiles';

export const metadata = { title: 'Chats' };

/**
 * The chat list. This is the permanent fallback UI (D-017) — the force-directed
 * space view is scheduled last precisely so that if it never lands, nothing
 * essential is missing.
 *
 * Every query here runs through the SESSION-BOUND client, so row-level security
 * does the filtering. There is no `where I am a member` clause anywhere in this
 * file, and that absence is the point: the list is correct because the database
 * refuses the rows, not because this component remembered to ask correctly.
 */
export default async function ChatsPage() {
  const actor = await requireActor();
  const supabase = await createClient();

  const { data: chats } = await supabase
    .from('chats')
    .select('id, type, name, required_clearance_id, created_at, clearances:required_clearance_id(name, level)')
    .order('created_at', { ascending: false });

  // Cast through unknown: embedded relations infer as arrays without the
  // Database generic. See the note at the foot of lib/db/types.ts.
  const rows = (chats ?? []) as unknown as {
    id: string; type: 'dm' | 'group' | 'agent'; name: string | null;
    required_clearance_id: string | null;
    clearances: { name: string; level: number } | null;
  }[];

  // Which of these am I actually a member of? A row can be visible for
  // discovery (a group I am cleared for) without my being in it.
  const { data: memberships } = await supabase
    .from('chat_members')
    .select('chat_id, status')
    .eq('user_id', actor.id);

  const myStatus = new Map(
    ((memberships ?? []) as { chat_id: string; status: string }[]).map((m) => [m.chat_id, m.status]),
  );

  const { data: allMembers } = await supabase
    .from('chat_members')
    .select('chat_id, user_id')
    .eq('status', 'member');

  const namesByChat = new Map<string, string[]>();
  const dmNames = await namesFor(
    supabase,
    ((allMembers ?? []) as unknown as { user_id: string }[]).map((r) => r.user_id),
  );

  for (const r of (allMembers ?? []) as unknown as { chat_id: string; user_id: string }[]) {
    const who = dmNames.get(r.user_id);
    if (!who) continue;
    const list = namesByChat.get(r.chat_id) ?? [];
    list.push(who.name);
    namesByChat.set(r.chat_id, list);
  }

  // Everyone the viewer could start a chat with. Profiles are readable by any
  // signed-in user by design — you cannot click a person to DM them if you
  // cannot see that they exist.
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name, color')
    .neq('id', actor.id)
    .order('display_name');

  // Only clearances the viewer HOLDS. create_chat() refuses a chat above your
  // own level anyway; offering the option would just be an error waiting to
  // happen.
  const { data: myClearances } = await supabase
    .from('user_clearances')
    .select('clearances(id, name, level)')
    .eq('user_id', actor.id);

  const people: Person[] = ((profiles ?? []) as unknown as
    { id: string; display_name: string; color: string }[]
  ).map((p) => ({ id: p.id, name: p.display_name, color: p.color }));

  const clearanceOptions: ClearanceOption[] = ((myClearances ?? []) as unknown as
    { clearances: ClearanceOption | null }[]
  ).map((r) => r.clearances).filter((c): c is ClearanceOption => Boolean(c))
    .sort((a, b) => a.level - b.level);

  const joined = rows.filter((c) => myStatus.get(c.id) === 'member');
  const discoverable = rows.filter((c) => myStatus.get(c.id) !== 'member');

  return (
    <div className="space-y-10">
      <section>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="mb-1 text-lg font-semibold">Your chats</h1>
            <p className="text-xs text-muted">
              The agent is present in every one of these and decides for itself
              whether to speak.
            </p>
          </div>
          <NewChat people={people} clearances={clearanceOptions} />
        </div>

        {joined.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {joined.map((c) => {
              const title = c.name ?? (c.type === 'dm' ? 'Direct message' : 'Untitled');
              return (
                <li key={c.id} className="relative">
                  <Link
                    href={`/chat/${c.id}`}
                    className="block rounded-lg border border-border bg-surface p-4 pr-9 transition hover:border-accent"
                  >
                    <ChatHeading chat={c} members={namesByChat.get(c.id) ?? []} />
                  </Link>
                  <PopOutButton
                    chatId={c.id}
                    title={title}
                    className="absolute right-2 top-2"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {discoverable.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold">Discoverable</h2>
          <p className="mb-4 max-w-2xl text-xs leading-relaxed text-muted">
            Groups you are cleared for but not a member of. You can see that
            they exist, and nothing else — no messages, no roster, no files.
            A chat above your clearance does not appear here at all, because the
            existence of a restricted conversation is itself disclosure.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {discoverable.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-dashed border-border bg-surface/50 p-4 opacity-70"
              >
                <ChatHeading chat={c} members={[]} />
                <p className="mt-2 text-xs text-muted">
                  {myStatus.get(c.id) === 'requested'
                    ? 'Join request pending.'
                    : 'Not a member.'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ChatHeading({
  chat, members,
}: {
  chat: { type: string; name: string | null; clearances: { name: string } | null };
  members: string[];
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium">
          {chat.name ?? (chat.type === 'dm' ? 'Direct message' : 'Untitled')}
        </span>
        <span className="shrink-0 rounded bg-accent-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent">
          {chat.clearances?.name ?? chat.type}
        </span>
      </div>
      {members.length > 0 && (
        <p className="mt-1 truncate text-xs text-muted">{members.join(', ')}</p>
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <p className="text-sm text-muted">
        You are not a member of any chat.
      </p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted">
        This is what a non-member sees — not an error, not an empty list with a
        hint of what is behind it. The database returns nothing, so there is
        nothing to render.
      </p>
    </div>
  );
}
