import { createClient, requireActor } from '@/lib/db/server';
import { namesFor } from '@/lib/db/profiles';
import { Rooms, type RoomSummary } from '@/app/_components/rooms/rooms';

export const metadata = { title: 'Rooms' };

/**
 * Every conversation you are in, with the chat itself alongside — the
 * Slack-shaped view.
 *
 * The workspace home answers "who and what exists here". This answers "what is
 * happening in the rooms I am already in", which is a different question and
 * was previously unanswerable: there was no way to see your conversations as a
 * list, so returning to one meant remembering which tile it was behind.
 *
 * This page replaced the old People/clearance-granting page. Granting moved to
 * the Account page rather than being dropped: it is the write path for
 * authorisation axis two (D-003) and a real product feature, so it belongs on
 * an ordinary page rather than behind the admin gate.
 *
 * ---------------------------------------------------------------------------
 * UNREAD, AND WHY IT IS APPROXIMATE
 *
 * There is no `last_read_at` column, and adding one is a schema change plus a
 * write on every chat open. So "unread" here means *messages since your own
 * last message in that room* — which is right for the common case and wrong if
 * you read without replying. It is labelled "new since you last wrote" rather
 * than "unread", because a number that means something slightly different from
 * its label is worse than a longer label.
 */
export default async function RoomsPage() {
  const actor = await requireActor();
  const supabase = await createClient();

  const { data: memberships } = await supabase
    .from('chat_members')
    .select('chat_id, role, chats(id, type, name, is_demo, demo_kind, clearances:required_clearance_id(name, level))')
    .eq('user_id', actor.id)
    .eq('status', 'member');

  const rows = ((memberships ?? []) as unknown as {
    chat_id: string;
    role: 'admin' | 'member';
    chats: {
      id: string; type: 'dm' | 'group' | 'agent'; name: string | null;
      is_demo: boolean; demo_kind: string | null;
      clearances: { name: string; level: number } | null;
    } | null;
  }[]).filter((m) => m.chats);

  const chatIds = rows.map((r) => r.chat_id);

  const [{ data: recent }, { data: rosters }] = chatIds.length
    ? await Promise.all([
        // Newest 400 across the viewer's rooms: enough to give every room a
        // preview and a count without a query per room.
        supabase
          .from('messages')
          .select('chat_id, sender_id, sender_type, content, created_at')
          .in('chat_id', chatIds)
          .order('created_at', { ascending: false })
          .limit(400),
        supabase
          .from('chat_members')
          .select('chat_id, user_id')
          .in('chat_id', chatIds)
          .eq('status', 'member'),
      ])
    : [{ data: [] }, { data: [] }];

  const messages = (recent ?? []) as unknown as {
    chat_id: string; sender_id: string | null; sender_type: 'user' | 'agent';
    content: string; created_at: string;
  }[];

  const memberRows = (rosters ?? []) as unknown as { chat_id: string; user_id: string }[];
  const names = await namesFor(supabase, memberRows.map((m) => m.user_id));

  const rosterByChat = new Map<string, { id: string; name: string; color: string }[]>();
  for (const m of memberRows) {
    const who = names.get(m.user_id);
    if (!who) continue;
    const list = rosterByChat.get(m.chat_id) ?? [];
    list.push({ id: m.user_id, name: who.name, color: who.color });
    rosterByChat.set(m.chat_id, list);
  }

  const rooms: RoomSummary[] = rows.map((r) => {
    const chat = r.chats!;
    const mine = messages.filter((m) => m.chat_id === r.chat_id);
    const latest = mine[0] ?? null;
    const myLast = mine.find((m) => m.sender_id === actor.id);
    const since = myLast
      ? mine.filter((m) => m.created_at > myLast.created_at && m.sender_id !== actor.id).length
      : mine.filter((m) => m.sender_id !== actor.id).length;

    const roster = rosterByChat.get(r.chat_id) ?? [];
    const others = roster.filter((p) => p.id !== actor.id);

    return {
      id: chat.id,
      type: chat.type,
      name:
        chat.name ??
        (chat.type === 'dm'
          ? others[0]?.name ?? 'Direct message'
          : chat.type === 'agent'
            ? 'Q'
            : 'Untitled'),
      clearance: chat.clearances,
      role: r.role,
      isDemo: chat.is_demo,
      demoKind: chat.demo_kind,
      members: others,
      memberCount: roster.length,
      lastMessage: latest
        ? {
            preview: latest.content.slice(0, 140),
            at: latest.created_at,
            fromAgent: latest.sender_type === 'agent',
            fromName: latest.sender_id === actor.id
              ? 'You'
              : latest.sender_type === 'agent'
                ? 'Q'
                : names.get(latest.sender_id ?? '')?.name ?? 'Someone',
          }
        : null,
      unread: since,
    };
  });

  // Busiest-first is wrong here: a room you have unread messages in should come
  // first even if it has been quiet for a week, because that is the reason you
  // opened this page.
  rooms.sort((a, b) => {
    if (a.unread !== b.unread) return b.unread - a.unread;
    const at = a.lastMessage?.at ?? '';
    const bt = b.lastMessage?.at ?? '';
    return bt.localeCompare(at);
  });

  return <Rooms rooms={rooms} meId={actor.id} />;
}
