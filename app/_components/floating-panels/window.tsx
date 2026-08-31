'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/db/browser';
import { namesFor } from '@/lib/db/profiles';
import { ChatSurface, type UiMessage } from '../chat-surface';
import { DemoStamp } from '../demo-stamp';
import type { EventRow, CallRow } from '../event-trace';
import { useFloatingPanels, type PanelState } from './context';

const MIN_W = 300;
const MIN_H = 320;

interface ChatData {
  type: 'dm' | 'group' | 'agent';
  name: string | null;
  isDemo: boolean;
  demoKind: string | null;
  amMember: boolean;
  meId: string;
  people: Record<string, { name: string; color: string }>;
  messages: UiMessage[];
  events: EventRow[];
  calls: CallRow[];
}

/**
 * One floating window. Loads its own chat data client-side — this is the price
 * of being a panel rather than a server-rendered page: there is no request
 * cycle to attach a server component to, so the same queries the chat page
 * makes on the server run here through the publishable-key browser client
 * instead. Same tables, same RLS, same result for the same user.
 */
export function FloatingPanelWindow({ panel }: { panel: PanelState }) {
  const { close, focus, toggleMinimize, toggleMaximize, update } = useFloatingPanels();
  const [data, setData] = useState<ChatData | 'loading' | 'error'>('loading');
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const meId = auth.user?.id;
      if (!meId) { if (!cancelled) setData('error'); return; }

      const [{ data: chat }, { data: members }, { data: messages }, { data: events }, { data: calls }] =
        await Promise.all([
          supabase.from('chats').select('type, name, is_demo, demo_kind').eq('id', panel.chatId).maybeSingle(),
          supabase.from('chat_members').select('user_id, status').eq('chat_id', panel.chatId),
          supabase
            .from('messages')
            .select('id, sender_type, sender_id, content, created_at, turn_id')
            .eq('chat_id', panel.chatId)
            .order('created_at', { ascending: true })
            .limit(100),
          supabase
            .from('agent_events')
            .select('id, turn_id, event_type, payload, created_at')
            .eq('chat_id', panel.chatId)
            .order('created_at', { ascending: false })
            .limit(150),
          supabase
            .from('llm_calls')
            .select('id, turn_id, purpose, model, status, input_tokens, output_tokens, cost_estimate')
            .eq('chat_id', panel.chatId)
            .order('created_at', { ascending: false })
            .limit(150),
        ]);

      if (cancelled) return;

      if (!chat) { setData('error'); return; }

      const roster = (members ?? []) as unknown as { user_id: string; status: string }[];
      const amMember = roster.some((m) => m.user_id === meId && m.status === 'member');
      const profileMap = await namesFor(supabase, roster.map((m) => m.user_id));
      if (cancelled) return;

      const people: Record<string, { name: string; color: string }> = {};
      for (const m of roster) {
        const p = profileMap.get(m.user_id);
        if (p && m.status === 'member') people[m.user_id] = p;
      }

      const rows = (messages ?? []) as unknown as {
        id: string; sender_type: 'user' | 'agent'; sender_id: string | null;
        content: string; created_at: string; turn_id: string;
      }[];

      setData({
        type: (chat as { type: 'dm' | 'group' | 'agent' }).type,
        name: (chat as { name: string | null }).name,
        isDemo: (chat as { is_demo: boolean }).is_demo,
        demoKind: (chat as { demo_kind: string | null }).demo_kind,
        amMember,
        meId,
        people,
        events: (events ?? []) as unknown as EventRow[],
        calls: (calls ?? []) as unknown as CallRow[],
        messages: rows.map((m) => ({
          id: m.id,
          senderType: m.sender_type,
          senderId: m.sender_id,
          senderName: m.sender_type === 'agent' ? 'Quorum' : people[m.sender_id ?? '']?.name ?? 'Someone',
          senderColor: people[m.sender_id ?? '']?.color ?? 'var(--agent)',
          content: m.content,
          createdAt: m.created_at,
          turnId: m.turn_id,
        })),
      });
    }

    // A throw inside load() would otherwise leave the panel on "Loading…"
    // forever, with nothing in the console to say why.
    void load().catch((err) => {
      console.error('[panel] could not load chat', panel.chatId, err);
      if (!cancelled) setData('error');
    });
    return () => { cancelled = true; };
  }, [panel.chatId]);

  // --- drag ------------------------------------------------------------
  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return; // don't drag from a button
    focus(panel.chatId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: panel.x, originY: panel.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [focus, panel.chatId, panel.x, panel.y]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    update(panel.chatId, {
      x: Math.max(0, dragRef.current.originX + dx),
      y: Math.max(0, dragRef.current.originY + dy),
    });
  }, [update, panel.chatId]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  // --- resize ------------------------------------------------------------
  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    focus(panel.chatId);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: panel.w, originH: panel.h };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [focus, panel.chatId, panel.w, panel.h]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const dx = e.clientX - resizeRef.current.startX;
    const dy = e.clientY - resizeRef.current.startY;
    update(panel.chatId, {
      w: Math.max(MIN_W, resizeRef.current.originW + dx),
      h: Math.max(MIN_H, resizeRef.current.originH + dy),
    });
  }, [update, panel.chatId]);

  const endResize = useCallback(() => { resizeRef.current = null; }, []);

  if (panel.minimized) return null; // rendered in the dock instead, see host.tsx

  const title =
    data !== 'loading' && data !== 'error'
      ? data.name ?? (data.type === 'dm' ? 'Direct message' : 'Chat')
      : panel.title;

  // Maximized panels are laid out by the viewport, not by their stored
  // geometry — which is kept untouched so restoring returns the panel to where
  // the user last put it rather than to the default cascade position.
  const geometry: React.CSSProperties = panel.maximized
    ? { inset: '0.75rem', zIndex: panel.z }
    : { left: panel.x, top: panel.y, width: panel.w, height: panel.h, zIndex: panel.z };

  return (
    <div
      className="pointer-events-auto absolute flex flex-col overflow-hidden border border-border-strong bg-background shadow-2xl"
      style={geometry}
      onPointerDown={() => focus(panel.chatId)}
    >
      <div
        onPointerDown={panel.maximized ? undefined : onHeaderPointerDown}
        onPointerMove={panel.maximized ? undefined : onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`flex shrink-0 items-center gap-2 border-b border-border bg-surface-raised px-3 py-2.5 ${
          panel.maximized ? '' : 'cursor-move'
        }`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="label min-w-0 truncate">{title}</span>
          {data !== 'loading' && data !== 'error' && data.isDemo && <DemoStamp />}
        </span>
        <Link
          href={`/chat/${panel.chatId}`}
          title="Open as a page"
          aria-label="Open this chat as a full page"
          className="px-1 text-xs text-muted transition hover:text-foreground"
        >
          ⤢
        </Link>
        <button
          onClick={() => toggleMaximize(panel.chatId)}
          title={panel.maximized ? 'Restore' : 'Full screen'}
          aria-label={panel.maximized ? 'Restore panel' : 'Expand panel to full screen'}
          className="px-1 text-xs text-muted transition hover:text-foreground"
        >
          {panel.maximized ? '❐' : '▢'}
        </button>
        <button
          onClick={() => toggleMinimize(panel.chatId)}
          title="Minimize"
          aria-label="Minimize panel"
          className="px-1 text-xs text-muted transition hover:text-foreground"
        >
          −
        </button>
        <button
          onClick={() => close(panel.chatId)}
          title="Close"
          aria-label="Close panel"
          className="px-1 text-xs text-muted transition hover:text-foreground"
        >
          ×
        </button>
      </div>

      {/* px-3 pb-3: the transcript and composer were flush against the panel
          border, which made a 360px window feel like a cramped tooltip rather
          than a chat. The full-page chat gets its padding from the page layout;
          a panel has no page, so it supplies its own. */}
      <div className="min-h-0 flex-1 px-3 pb-3">
        {data === 'loading' && (
          // A skeleton in the shape of the transcript, not the word "Loading".
          // Opening a DM for the first time also creates it, which takes a
          // moment, and an empty box for two seconds reads as a broken panel.
          <div className="flex h-full flex-col justify-end gap-3 p-4" aria-busy="true">
            <span className="sr-only">Opening conversation</span>
            <span className="h-3 w-2/5 animate-pulse bg-surface-raised" />
            <span className="h-3 w-3/5 animate-pulse self-end bg-surface-raised" />
            <span className="h-3 w-1/3 animate-pulse bg-surface-raised" />
          </div>
        )}
        {data === 'error' && (
          <p className="p-4 text-xs text-muted">This chat could not be opened.</p>
        )}
        {data !== 'loading' && data !== 'error' && !data.amMember && (
          <p className="p-4 text-xs text-muted">You are not a member of this chat.</p>
        )}
        {data !== 'loading' && data !== 'error' && data.amMember && (
          <ChatSurface
            chatId={panel.chatId}
            meId={data.meId}
            initialMessages={data.messages}
            people={data.people}
            initialEvents={data.events}
            initialCalls={data.calls}
            containerClassName="flex h-full flex-col"
            demoKind={data.demoKind}
          />
        )}
      </div>

      {/* No resize grip while maximized — the viewport is setting the size. */}
      {!panel.maximized && (
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        title="Resize"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, var(--border-strong) 50% 60%, transparent 60% 70%, var(--border-strong) 70% 80%, transparent 80%)',
        }}
      />
      )}
    </div>
  );
}
