import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient, requireActor } from '@/lib/db/server';
import { ChatSurface, type UiMessage } from '@/app/_components/chat-surface';
import { InternalView, type EventRow, type CallRow } from '@/app/_components/internal-view';

/**
 * A chat.
 *
 * Note what is NOT here: any check that the reader is a member, or cleared.
 * Every query runs through the session-bound client, so RLS refuses the rows.
 * If the chat is not readable, `chat` comes back null and this 404s — the same
 * response a non-existent chat gives, so the page cannot be used to probe which
 * chats exist.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;
  const actor = await requireActor();
  const supabase = await createClient();

  const { data: chat } = await supabase
    .from('chats')
    .select('id, type, name, clearances:required_clearance_id(name, level)')
    .eq('id', chatId)
    .maybeSingle();

  if (!chat) notFound();

  const [{ data: messages }, { data: members }] = await Promise.all([
    supabase
      .from('messages')
      .select('id, sender_type, sender_id, content, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .limit(200),
    supabase
      .from('chat_members')
      .select('user_id, role, profiles:user_id(display_name, color)')
      .eq('chat_id', chatId)
      .eq('status', 'member'),
  ]);

  // A readable chat row with an unreadable roster means discovery-only access:
  // cleared for the group, but not a member of it.
  // Cast through unknown: without the Database generic, supabase-js infers
  // embedded relations as arrays regardless of cardinality.
  const roster = (members ?? []) as unknown as {
    user_id: string; role: string;
    profiles: { display_name: string; color: string } | null;
  }[];
  const amMember = roster.some((m) => m.user_id === actor.id);

  const people: Record<string, { name: string; color: string }> = {};
  for (const m of roster) {
    if (m.profiles) people[m.user_id] = { name: m.profiles.display_name, color: m.profiles.color };
  }

  const chatRow = chat as unknown as {
    id: string; type: 'dm' | 'group' | 'agent'; name: string | null;
    clearances: { name: string; level: number } | null;
  };

  if (!amMember) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-dashed border-border p-8 text-center">
        <h1 className="text-sm font-medium">
          {chatRow.name ?? 'This chat'}
        </h1>
        <p className="mt-3 text-sm text-muted">You are not a member of this chat.</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          You can see that it exists because you meet its clearance level. That
          is all discovery grants — no messages, no roster, no files.
        </p>
        <Link href="/chats" className="mt-6 inline-block text-xs text-accent underline">
          Back to chats
        </Link>
      </div>
    );
  }

  // The internal view reads the same tables through the same RLS. A viewer who
  // cannot access the chat gets an empty panel for the same reason they get an
  // empty chat — there is no separate authorisation path to get wrong.
  const [{ data: events }, { data: calls }] = await Promise.all([
    supabase
      .from('agent_events')
      .select('id, turn_id, event_type, payload, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(300),
    supabase
      .from('llm_calls')
      .select('id, turn_id, purpose, model, status, input_tokens, output_tokens, cost_estimate')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(300),
  ]);

  const initial: UiMessage[] = (
    (messages ?? []) as unknown as {
      id: string; sender_type: 'user' | 'agent'; sender_id: string | null;
      content: string; created_at: string;
    }[]
  ).map((m) => ({
    id: m.id,
    senderType: m.sender_type,
    senderId: m.sender_id,
    senderName:
      m.sender_type === 'agent'
        ? 'Quorum'
        : people[m.sender_id ?? '']?.name ?? 'Someone',
    senderColor: people[m.sender_id ?? '']?.color ?? 'var(--agent)',
    content: m.content,
    createdAt: m.created_at,
  }));

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-border pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">
            {chatRow.name ?? (chatRow.type === 'dm' ? 'Direct message' : 'Chat')}
          </h1>
          <p className="mt-0.5 truncate text-xs text-muted">
            {roster.map((m) => m.profiles?.display_name ?? '…').join(', ')}
          </p>
        </div>
        <span className="shrink-0 rounded bg-accent-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent">
          {chatRow.clearances?.name ?? 'General'}
        </span>
      </div>

      <ChatSurface
        chatId={chatId}
        meId={actor.id}
        initialMessages={initial}
        people={people}
      />

      <InternalView
        chatId={chatId}
        initialEvents={(events ?? []) as unknown as EventRow[]}
        initialCalls={(calls ?? []) as unknown as CallRow[]}
      />
    </div>
  );
}
