import { createClient, requireActor } from '@/lib/db/server';
import { myMemory } from '@/lib/memory/mine';
import { namesFor } from '@/lib/db/profiles';
import { MemoryList } from '@/app/_components/memory-list';

export const metadata = { title: 'Memory' };

/**
 * Everything the agent has recorded about you, in one place.
 *
 * This is the subject-access side of the memory system, and it exists because
 * a product whose whole argument is about who may see what would be a poor
 * one to also quietly build a profile of someone with no way for them to look
 * at it. `public.my_memory()` (migration 0019) is the one read path into
 * memory that is not the agent's — see `lib/memory/mine.ts` for why it is a
 * different question from retrieval, not a public door into the same table.
 *
 * Origin chat NAMES are resolved here, through the ORDINARY session client —
 * RLS decides whether you may still see the room a fact came from. A chat you
 * have since left still names correctly (you were a member once, and `chats`
 * itself has no membership check on SELECT beyond discovery — see D-027); a
 * gated chat you never held clearance for resolves to nothing, and the page
 * says "a chat you cannot open" rather than leaking its name.
 */
export default async function MemoryPage() {
  const actor = await requireActor();
  const supabase = await createClient();

  const items = await myMemory(supabase);

  const chatIds = [...new Set(items.map((i) => i.originChatId))];
  const { data: chats } = chatIds.length
    ? await supabase.from('chats').select('id, type, name').in('id', chatIds)
    : { data: [] };

  const chatRows = (chats ?? []) as unknown as { id: string; type: string; name: string | null }[];
  const chatById = new Map(chatRows.map((c) => [c.id, c]));

  // Names of who ELSE was in the origin chat, for chats the viewer can still
  // see the roster of. Best-effort: a chat left long ago may no longer resolve,
  // and that is fine — the audience SIZE from my_memory() is the number that
  // matters, this is only colour.
  const { data: rosterRows } = chatIds.length
    ? await supabase.from('chat_members').select('chat_id, user_id').in('chat_id', chatIds)
    : { data: [] };

  const rosterByChat = new Map<string, string[]>();
  for (const r of (rosterRows ?? []) as unknown as { chat_id: string; user_id: string }[]) {
    if (r.user_id === actor.id) continue;
    const list = rosterByChat.get(r.chat_id) ?? [];
    list.push(r.user_id);
    rosterByChat.set(r.chat_id, list);
  }
  const allOtherIds = [...new Set([...rosterByChat.values()].flat())];
  const names = await namesFor(supabase, allOtherIds);

  const enriched = items.map((item) => {
    const chat = chatById.get(item.originChatId);
    const otherNames = (rosterByChat.get(item.originChatId) ?? [])
      .map((id) => names.get(id)?.name)
      .filter((n): n is string => Boolean(n));
    return {
      ...item,
      originChatName: chat?.name ?? (chat?.type === 'dm' ? 'a direct message' : null),
      originChatKnown: Boolean(chat),
      otherNames,
    };
  });

  return <MemoryList items={enriched} />;
}
