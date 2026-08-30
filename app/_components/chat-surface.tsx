'use client';

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/db/browser';
import { MessageContent } from './message-content';
import { TurnTrace } from './turn-trace';
import type { EventRow, CallRow } from './event-trace';
import { matchingCommands, SLASH_COMMANDS } from './slash-commands';

export interface UiMessage {
  id: string;
  senderType: 'user' | 'agent';
  senderId: string | null;
  senderName: string;
  senderColor: string;
  content: string;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
  /** The turn this message belongs to. Absent for a draft not yet acknowledged. */
  turnId?: string;
}

export function ChatSurface({
  chatId,
  meId,
  initialMessages,
  people,
  initialEvents = [],
  initialCalls = [],
  containerClassName = 'flex h-[calc(100vh-16rem)] min-h-[24rem] flex-col',
}: {
  chatId: string;
  meId: string;
  initialMessages: UiMessage[];
  people: Record<string, { name: string; color: string }>;
  /** Seeds TurnTrace for already-loaded messages, so an old turn does not
   *  flash "sent…" before its live subscription confirms it already finished. */
  initialEvents?: EventRow[];
  /** Seeds TurnTrace's cost/token line. See CallRow note in turn-trace.tsx. */
  initialCalls?: CallRow[];
  /** Overridable so the floating-panel host can fit this into a fixed-height
   *  window instead of the full-page layout's viewport-relative sizing. */
  containerClassName?: string;
}) {
  const router = useRouter();
  const [revoked, setRevoked] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [optimistic, addOptimistic] = useOptimistic(
    messages,
    (current, next: UiMessage) => [...current, next],
  );
  const [, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);
  // clientMessageId -> turnId, for the pending draft before the persisted row
  // (which carries turn_id itself) arrives over Realtime.
  const [pendingTurns, setPendingTurns] = useState<Record<string, string>>({});

  const eventsByTurn = useMemo(() => {
    const map: Record<string, EventRow[]> = {};
    for (const e of initialEvents) (map[e.turn_id] ??= []).push(e);
    return map;
  }, [initialEvents]);

  const callsByTurn = useMemo(() => {
    const map: Record<string, CallRow[]> = {};
    for (const c of initialCalls) (map[c.turn_id] ??= []).push(c);
    return map;
  }, [initialCalls]);

  // A turn that already produced an agent message renders its trace under
  // THAT message, not under the user's — otherwise a spoken reply would show
  // its telemetry twice.
  const turnsWithReply = useMemo(
    () => new Set(optimistic.filter((m) => m.senderType === 'agent' && m.turnId).map((m) => m.turnId!)),
    [optimistic],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [optimistic.length]);

  /**
   * Realtime, and T11.
   *
   * Supabase Realtime evaluates row-level security when a subscription is
   * established and caches that result for the socket's lifetime. A member
   * removed mid-session therefore keeps receiving new messages on an
   * already-open socket, even though their next READ is refused.
   *
   * The second subscription below listens for a revocation broadcast aimed at
   * this user and tears everything down. It narrows the window from "until the
   * socket drops" to "within a round trip" — but it is COOPERATIVE, not
   * enforcement: this code runs in the browser being revoked. Closing the
   * window properly needs a server-side socket termination that Supabase does
   * not expose. The README says "next read" for exactly this reason.
   */
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`chat:${chatId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
        (payload) => {
          const row = payload.new as {
            id: string; sender_type: 'user' | 'agent'; sender_id: string | null;
            content: string; created_at: string; turn_id: string;
          };
          setMessages((current) => {
            if (current.some((m) => m.id === row.id)) return current;
            const who = row.sender_id ? people[row.sender_id] : undefined;
            return [
              ...current.filter((m) => !(m.pending && m.content === row.content)),
              {
                id: row.id,
                senderType: row.sender_type,
                senderId: row.sender_id,
                senderName: row.sender_type === 'agent' ? 'Quorum' : who?.name ?? 'Someone',
                senderColor: who?.color ?? 'var(--agent)',
                content: row.content,
                createdAt: row.created_at,
                turnId: row.turn_id,
              },
            ];
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [chatId, people]);

  useEffect(() => {
    const supabase = createClient();
    const revocation = supabase
      .channel(`membership:${meId}:${Math.random().toString(36).slice(2)}`)
      .on('broadcast', { event: 'revoked' }, (msg) => {
        const payload = msg.payload as { chatId?: string };
        if (payload?.chatId && payload.chatId !== chatId) return;
        setRevoked(true);
        void supabase.removeAllChannels();
        router.refresh();
      })
      .subscribe();
    return () => { void supabase.removeChannel(revocation); };
  }, [chatId, meId, router]);

  const send = useCallback(
    async (text: string) => {
      // Client-generated, so a retry of the same send is recognisable as the
      // same message rather than as a second one.
      const clientMessageId = crypto.randomUUID();
      const draft: UiMessage = {
        id: `pending:${clientMessageId}`,
        senderType: 'user',
        senderId: meId,
        senderName: people[meId]?.name ?? 'You',
        senderColor: people[meId]?.color ?? 'var(--accent)',
        content: text,
        createdAt: new Date().toISOString(),
        pending: true,
      };

      startTransition(() => addOptimistic(draft));

      try {
        const res = await fetch(`/api/chats/${chatId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, clientMessageId }),
        });
        if (!res.ok) throw new Error(await res.text());
        // The persisted row arrives over Realtime and replaces the draft there,
        // so nothing is appended here — appending would double it.
        //
        // The turn id arrives here, synchronously, well before the reply does
        // (the turn runs in after() and may take seconds). Recording it against
        // the draft is what lets a live trace attach to the user's OWN message
        // the instant it is sent, rather than only once a reply exists to hang
        // it on.
        const json = await res.json().catch(() => null) as { turnId?: string } | null;
        if (json?.turnId) {
          setPendingTurns((cur) => ({ ...cur, [clientMessageId]: json.turnId! }));
        }
      } catch {
        setMessages((current) => [...current, { ...draft, pending: false, failed: true }]);
      }
    },
    [chatId, meId, people, addOptimistic],
  );

  if (revoked) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm">You are no longer a member of this chat.</p>
        <p className="mt-2 text-xs text-muted">
          Live updates have been stopped. Reloading will show what you can still
          access — which, for this chat, is nothing.
        </p>
      </div>
    );
  }

  return (
    <div className={containerClassName}>
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {optimistic.length === 0 && (
          <p className="py-12 text-center text-sm text-muted">No messages yet.</p>
        )}
        {optimistic.map((m) => {
          const pendingId = m.pending && m.id.startsWith('pending:') ? m.id.slice('pending:'.length) : null;
          const turnId = m.turnId ?? (pendingId ? pendingTurns[pendingId] : undefined);
          // A turn that already produced a spoken reply shows its trace under
          // THAT message. A user's own message only carries the trace while no
          // reply exists yet — still running, or resolved silent.
          const showTrace =
            turnId !== undefined && (m.senderType === 'agent' || !turnsWithReply.has(turnId));
          return (
            <MessageRow
              key={m.id}
              message={m}
              isMe={m.senderId === meId}
              turnId={showTrace ? turnId : undefined}
              initialEvents={turnId ? eventsByTurn[turnId] : undefined}
              initialCalls={turnId ? callsByTurn[turnId] : undefined}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>
      <Composer chatId={chatId} onSend={send} />
    </div>
  );
}

function MessageRow({
  message,
  isMe,
  turnId,
  initialEvents,
  initialCalls,
}: {
  message: UiMessage;
  isMe: boolean;
  turnId?: string;
  initialEvents?: EventRow[];
  initialCalls?: CallRow[];
}) {
  const isAgent = message.senderType === 'agent';

  // The agent is aligned right with a monochrome treatment and a monospace
  // label, so it is never mistaken for a person at a glance. Humans get their
  // own colour; the agent deliberately gets none.
  return (
    <div className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'}`}>
      <div className={`max-w-[85%] ${isAgent ? 'text-right' : ''}`}>
        <span
          className={`mb-1 block text-xs ${isAgent ? 'font-mono uppercase tracking-wider text-agent' : ''}`}
          style={isAgent ? undefined : { color: message.senderColor }}
        >
          {isAgent ? 'Quorum' : isMe ? 'You' : message.senderName}
        </span>
        <div
          className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
            isAgent
              ? 'border border-border bg-surface-raised text-foreground'
              : 'bg-surface'
          } ${message.pending ? 'opacity-50' : ''} ${
            message.failed ? 'border border-danger' : ''
          }`}
        >
          <MessageContent content={message.content} />
        </div>
        {turnId && (
          <TurnTrace
            turnId={turnId}
            initialEvents={initialEvents}
            initialCalls={initialCalls}
            pendingSend={message.senderType === 'user'}
          />
        )}
        {message.failed && (
          <span className="mt-1 block text-xs text-danger">Not sent.</span>
        )}
      </div>
    </div>
  );
}

function Composer({
  chatId, onSend,
}: {
  chatId: string;
  onSend: (text: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Dismissible independently of `value`, so backspacing out of "/research "
  // after picking it does not reopen the menu on every keystroke.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = menuDismissed ? [] : matchingCommands(value);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    setValue('');
    setMenuDismissed(false);
    await onSend(text);
  }

  function pickCommand(usage: string) {
    // Position the cursor right after "/research ", ready to type the question,
    // rather than leaving the user to click back into the field.
    const withSpace = usage.replace(/<[^>]+>$/, '').trimEnd() + ' ';
    setValue(withSpace);
    setMenuDismissed(true);
    inputRef.current?.focus();
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setNotice(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/chats/${chatId}/files`, { method: 'POST', body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'upload failed');
      // The agent finds files through file_list rather than being told about
      // them, so a message is a convenience, not the mechanism.
      setNotice(`Attached ${json.filename}. Ask the agent about it.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-4">
      {notice && <p className="mb-2 text-xs text-muted">{notice}</p>}
      {/* The composer is the only place a user learns these exist, so both
          affordances are named here rather than in documentation nobody opens. */}
      <form onSubmit={submit} className="flex gap-2">
        <label
          className="grid cursor-pointer place-items-center rounded-lg border border-border bg-surface-raised px-3 text-sm transition hover:border-accent"
          title="Attach a document — txt, md, csv, html, json, xml, PDF or Word (.docx)"
        >
          {uploading ? '…' : '+'}
          <input
            type="file"
            onChange={upload}
            disabled={uploading}
            accept=".txt,.md,.csv,.html,.json,.xml,.pdf,.docx,text/plain,text/markdown,text/csv,text/html,application/json,application/xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
          />
        </label>
        <div className="relative flex-1">
          {suggestions.length > 0 && (
            <ul
              role="listbox"
              // z-50: the floating-panel host sits at z-40 (see
              // floating-panels/host.tsx). Without an explicit z-index here this
              // popup renders BEHIND an open panel — found by actually opening
              // one and typing "/" on the page underneath it, not by inspecting
              // either component in isolation.
              className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg"
            >
              {suggestions.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => pickCommand(c.usage)}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs transition hover:bg-accent-soft"
                  >
                    <span className="font-mono text-foreground">{c.usage}</span>
                    <span className="text-muted">{c.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => { setValue(e.target.value); setMenuDismissed(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape') setMenuDismissed(true); }}
            placeholder="Message — @quorum to address the agent, / for commands"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-accent"
          />
        </div>
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded-lg border border-border bg-surface-raised px-4 text-sm transition hover:border-accent disabled:opacity-40"
        >
          Send
        </button>
      </form>
      {suggestions.length === 0 &&
        SLASH_COMMANDS.some((c) => value.trim().toLowerCase().startsWith(c.name)) && (
          <p className="mt-2 text-xs text-muted">
            {SLASH_COMMANDS.find((c) => value.trim().toLowerCase().startsWith(c.name))?.description}
          </p>
        )}
    </div>
  );
}
