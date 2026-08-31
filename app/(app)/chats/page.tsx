import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';
import { namesFor } from '@/lib/db/profiles';
import { NewChat, type Person, type ClearanceOption } from '@/app/_components/new-chat';
import {
  Workspace,
  type DirectoryPerson,
  type GroupTile,
} from '@/app/_components/home/workspace';

export const metadata = { title: 'Workspace' };

/**
 * The workspace home: everyone, every group you can see, and the agent.
 *
 * Every query here runs through the SESSION-BOUND client, so row-level security
 * does the filtering. There is no `where I am a member` clause anywhere in this
 * file, and that absence is the point — the page is correct because the database
 * refuses the rows, not because this component remembered to ask correctly.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PLACE THIS FILE MAKES AN AUTHORISATION DECISION
 *
 * It decides what NOT to send. For a group the viewer is cleared for but not a
 * member of, the member names are never fetched into the payload — the tile
 * renders redaction bars over an absence rather than over hidden text. RLS
 * would already refuse those rows, so this is belt and braces; but it means the
 * redaction is honest in view-source, not just on screen, and for a product
 * whose whole claim is that unauthorised content never reaches the client that
 * distinction is the difference between a demo and the thing itself.
 */
export default async function WorkspacePage() {
  const actor = await requireActor();
  const supabase = await createClient();

  const [
    { data: chats },
    { data: myMemberships },
    { data: profiles },
    { data: myClearances },
    { data: allGrants },
  ] = await Promise.all([
    supabase
      .from('chats')
      .select('id, type, name, created_at, is_demo, clearances:required_clearance_id(name, level)')
      .order('created_at', { ascending: false }),
    supabase.from('chat_members').select('chat_id, status, role').eq('user_id', actor.id),
    supabase.from('profiles').select('id, display_name, color').eq('is_demo', false).order('display_name'),
    supabase.from('user_clearances').select('clearances(id, name, level)').eq('user_id', actor.id),
    supabase.from('user_clearances').select('user_id, clearances(name, level)'),
  ]);

  // Cast through unknown: embedded relations infer as arrays without narrowing.
  const chatRows = (chats ?? []) as unknown as {
    id: string;
    type: 'dm' | 'group' | 'agent';
    name: string | null;
    is_demo: boolean;
    clearances: { name: string; level: number } | null;
  }[];

  const mine = new Map(
    ((myMemberships ?? []) as unknown as
      { chat_id: string; status: string; role: 'admin' | 'member' }[]
    ).map((m) => [m.chat_id, m]),
  );

  // Rosters for chats the viewer is IN. Not fetched for discoverable groups —
  // see the note above; the redaction has nothing behind it by construction.
  const joinedIds = chatRows.filter((c) => mine.get(c.id)?.status === 'member').map((c) => c.id);

  const { data: joinedMembers } = joinedIds.length
    ? await supabase
        .from('chat_members')
        .select('chat_id, user_id')
        .in('chat_id', joinedIds)
        .eq('status', 'member')
    : { data: [] };

  const rosterRows = (joinedMembers ?? []) as unknown as { chat_id: string; user_id: string }[];
  const rosterNames = await namesFor(supabase, rosterRows.map((r) => r.user_id));

  const byChat = new Map<string, string[]>();
  const idsByChat = new Map<string, string[]>();
  for (const r of rosterRows) {
    const ids = idsByChat.get(r.chat_id) ?? [];
    ids.push(r.user_id);
    idsByChat.set(r.chat_id, ids);

    const who = rosterNames.get(r.user_id);
    if (!who) continue;
    const names = byChat.get(r.chat_id) ?? [];
    names.push(who.name);
    byChat.set(r.chat_id, names);
  }

  // ---- people ------------------------------------------------------------
  const highest = new Map<string, { name: string; level: number }>();
  for (const g of (allGrants ?? []) as unknown as
    { user_id: string; clearances: { name: string; level: number } | null }[]) {
    if (!g.clearances) continue;
    const cur = highest.get(g.user_id);
    if (!cur || g.clearances.level > cur.level) highest.set(g.user_id, g.clearances);
  }

  // An existing DM per person, so a tile can open straight into it rather than
  // round-tripping /api/dm to discover it already exists.
  const dmByPerson = new Map<string, string>();
  for (const c of chatRows) {
    if (c.type !== 'dm' || mine.get(c.id)?.status !== 'member') continue;
    const other = (idsByChat.get(c.id) ?? []).find((id) => id !== actor.id);
    if (other) dmByPerson.set(other, c.id);
  }

  const people: DirectoryPerson[] = ((profiles ?? []) as unknown as
    { id: string; display_name: string; color: string }[]
  )
    .filter((p) => p.id !== actor.id)
    .map((p) => ({
      id: p.id,
      name: p.display_name,
      color: p.color,
      clearance: highest.get(p.id) ?? null,
      dmChatId: dmByPerson.get(p.id) ?? null,
    }));

  // ---- groups ------------------------------------------------------------
  const groups: GroupTile[] = chatRows
    .filter((c) => {
      if (c.type !== 'group') return false;
      // A per-user demo world's isolation group (migration 0020) is ungated on
      // purpose, so RLS returns it to every authenticated user for discovery —
      // correct for a real group, but it means every new signup's own demo
      // room would otherwise pile up as a "not a member" tile in everyone
      // else's workspace, forever. Only show a demo group here to its own
      // members; Rooms is where they'd actually open it.
      if (c.is_demo) return mine.get(c.id)?.status === 'member';
      return true;
    })
    .map((c) => {
      const m = mine.get(c.id);
      const isMember = m?.status === 'member';
      return {
        id: c.id,
        name: c.name ?? 'Untitled group',
        clearance: c.clearances,
        memberNames: isMember ? (byChat.get(c.id) ?? []) : [],
        memberCount: isMember ? (byChat.get(c.id) ?? []).length : null,
        status: isMember ? 'member' : m?.status === 'requested' ? 'requested' : 'discoverable',
        role: isMember ? (m?.role ?? 'member') : null,
        isDemo: c.is_demo,
      };
    });

  // The viewer's own solo chat with the agent, if they have made one.
  const agentChatId =
    chatRows.find((c) => c.type === 'agent' && mine.get(c.id)?.status === 'member')?.id ?? null;

  const clearanceOptions: ClearanceOption[] = ((myClearances ?? []) as unknown as
    { clearances: ClearanceOption | null }[]
  )
    .map((r) => r.clearances)
    .filter((c): c is ClearanceOption => Boolean(c))
    .sort((a, b) => a.level - b.level);

  const newChatPeople: Person[] = people.map((p) => ({ id: p.id, name: p.name, color: p.color }));

  return (
    <div className="space-y-10">
      <Workspace
        people={people}
        groups={groups}
        agentChatId={agentChatId}
        newChat={<NewChat people={newChatPeople} clearances={clearanceOptions} />}
      />

      <section className="border-t border-border pt-6">
        <Link
          href="/account"
          className="text-xs text-foreground underline underline-offset-4"
        >
          Your clearances and groups
        </Link>
      </section>
    </div>
  );
}
