'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/db/browser';
import { namesFor } from '@/lib/db/profiles';
import { ChatSurface, type UiMessage } from '../chat-surface';
import { ClearanceStamp } from '../clearance';
import type { EventRow, CallRow } from '../event-trace';

export interface RoomSummary {
  id: string;
  type: 'dm' | 'group' | 'agent';
  name: string;
  clearance: { name: string; level: number } | null;
  role: 'admin' | 'member';
  members: { id: string; name: string; color: string }[];
  memberCount: number;
  lastMessage: { preview: string; at: string; fromAgent: boolean; fromName: string } | null;
  unread: number;
}

/**
 * The rooms view: a list of conversations on the left, the open one on the
 * right, both on the same screen.
 *
 * The chat loads client-side when a room is selected, the same way a floating
 * panel does, so switching rooms does not round-trip the server for a new page.
 * It is the same `ChatSurface`, the same queries and the same RLS — this view
 * adds a way to navigate, not a second way to read.
 */
export function Rooms({ rooms, meId }: { rooms: RoomSummary[]; meId: string }) {
  const [selected, setSelected] = useState<string | null>(rooms[0]?.id ?? null);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (r: RoomSummary) => !q || r.name.toLowerCase().includes(q);
    return {
      agent: rooms.filter((r) => r.type === 'agent' && match(r)),
      dms: rooms.filter((r) => r.type === 'dm' && match(r)),
      groups: rooms.filter((r) => r.type === 'group' && match(r)),
    };
  }, [rooms, filter]);

  const open = rooms.find((r) => r.id === selected) ?? null;

  if (rooms.length === 0) {
    return (
      <div className="border border-dashed border-border p-10 text-center">
        <p className="text-sm">No conversations yet.</p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted">
          Open someone from the workspace directory, or press Q to talk to the
          agent on its own.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
      <aside className="flex max-h-[calc(100vh-9rem)] flex-col border border-border bg-surface">
        <div className="border-b border-border p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter rooms"
            aria-label="Filter rooms"
            className="w-full bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RoomGroup label="Agent" rooms={groups.agent} selected={selected} onSelect={setSelected} />
          <RoomGroup label="Direct" rooms={groups.dms} selected={selected} onSelect={setSelected} />
          <RoomGroup label="Groups" rooms={groups.groups} selected={selected} onSelect={setSelected} />
        </div>
      </aside>

      <section className="min-w-0">
        {open ? <RoomPane key={open.id} room={open} meId={meId} /> : null}
      </section>
    </div>
  );
}

function RoomGroup({
  label,
  rooms,
  selected,
  onSelect,
}: {
  label: string;
  rooms: RoomSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (rooms.length === 0) return null;
  return (
    <div className="border-b border-border py-2 last:border-b-0">
      <p className="label px-3 pb-1 text-muted">{label}</p>
      <ul>
        {rooms.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left transition ${
                selected === r.id ? 'bg-surface-raised' : 'hover:bg-surface-raised'
              }`}
            >
              <span
                className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center text-[10px] font-semibold"
                style={
                  r.type === 'agent'
                    ? { background: 'var(--ink)', color: 'var(--on-ink)' }
                    : { background: r.members[0]?.color ?? 'var(--border-strong)', color: 'var(--on-paper)' }
                }
                aria-hidden
              >
                {r.type === 'agent' ? 'Q' : r.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                  {r.unread > 0 && (
                    <span
                      className="label shrink-0 px-1.5 py-0.5"
                      style={{ background: 'var(--paper)', color: 'var(--on-paper)' }}
                      title={`${r.unread} new since you last wrote`}
                    >
                      {r.unread}
                    </span>
                  )}
                </span>
                {r.lastMessage && (
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {r.lastMessage.fromName}: {r.lastMessage.preview}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Loaded {
  people: Record<string, { name: string; color: string }>;
  messages: UiMessage[];
  events: EventRow[];
  calls: CallRow[];
}

/**
 * One open room. Loads its own data client-side — the same trade the floating
 * panel makes, and for the same reason: there is no request cycle to hang a
 * server component off when the selection changes without navigating.
 */
function RoomPane({ room, meId }: { room: RoomSummary; meId: string }) {
  const [data, setData] = useState<Loaded | 'loading' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabase = createClient();
      const [{ data: members }, { data: messages }, { data: events }, { data: calls }] =
        await Promise.all([
          supabase.from('chat_members').select('user_id').eq('chat_id', room.id).eq('status', 'member'),
          supabase
            .from('messages')
            .select('id, sender_type, sender_id, content, created_at, turn_id')
            .eq('chat_id', room.id)
            .order('created_at', { ascending: true })
            .limit(200),
          supabase
            .from('agent_events')
            .select('id, turn_id, event_type, payload, created_at')
            .eq('chat_id', room.id)
            .order('created_at', { ascending: false })
            .limit(200),
          supabase
            .from('llm_calls')
            .select('id, turn_id, purpose, model, status, input_tokens, output_tokens, cost_estimate')
            .eq('chat_id', room.id)
            .order('created_at', { ascending: false })
            .limit(200),
        ]);
      if (cancelled) return;

      const ids = ((members ?? []) as unknown as { user_id: string }[]).map((m) => m.user_id);
      const map = await namesFor(supabase, ids);
      if (cancelled) return;

      const people: Record<string, { name: string; color: string }> = {};
      for (const [id, p] of map) people[id] = p;

      const rows = (messages ?? []) as unknown as {
        id: string; sender_type: 'user' | 'agent'; sender_id: string | null;
        content: string; created_at: string; turn_id: string;
      }[];

      setData({
        people,
        events: (events ?? []) as unknown as EventRow[],
        calls: (calls ?? []) as unknown as CallRow[],
        messages: rows.map((m) => ({
          id: m.id,
          senderType: m.sender_type,
          senderId: m.sender_id,
          senderName:
            m.sender_type === 'agent' ? 'Quorum' : people[m.sender_id ?? '']?.name ?? 'Someone',
          senderColor: people[m.sender_id ?? '']?.color ?? 'var(--agent)',
          content: m.content,
          createdAt: m.created_at,
          turnId: m.turn_id,
        })),
      });
    }

    void load().catch((err) => {
      console.error('[rooms] could not load', room.id, err);
      if (!cancelled) setData('error');
    });
    return () => { cancelled = true; };
  }, [room.id]);

  return (
    <div className="flex max-h-[calc(100vh-9rem)] flex-col border border-border bg-surface">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-base font-semibold">{room.name}</span>
          <span className="label text-muted">
            {room.type === 'agent'
              ? 'Just you and the agent'
              : `${room.memberCount} member${room.memberCount === 1 ? '' : 's'}${
                  room.role === 'admin' ? ' · admin' : ''
                }`}
          </span>
        </span>
        <ClearanceStamp level={room.clearance?.level ?? 0} name={room.clearance?.name} />
        <a
          href={`/chat/${room.id}`}
          title="Open as a page"
          className="label border border-border px-2 py-1 text-muted transition hover:text-foreground"
        >
          Full page
        </a>
      </header>

      <div className="min-h-0 flex-1 px-4 pb-4">
        {data === 'loading' && (
          <div className="flex h-full flex-col justify-end gap-3 py-4" aria-busy="true">
            <span className="sr-only">Opening conversation</span>
            <span className="h-3 w-2/5 animate-pulse bg-surface-raised" />
            <span className="h-3 w-3/5 animate-pulse self-end bg-surface-raised" />
            <span className="h-3 w-1/3 animate-pulse bg-surface-raised" />
          </div>
        )}
        {data === 'error' && (
          <p className="py-6 text-xs text-muted">This conversation could not be opened.</p>
        )}
        {data !== 'loading' && data !== 'error' && (
          <ChatSurface
            chatId={room.id}
            meId={meId}
            initialMessages={data.messages}
            people={data.people}
            initialEvents={data.events}
            initialCalls={data.calls}
            containerClassName="flex h-full flex-col"
          />
        )}
      </div>
    </div>
  );
}
