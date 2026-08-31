'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/db/browser';
import { MessageContent } from './message-content';
import { TurnTrace } from './turn-trace';
import type { EventRow, CallRow } from './event-trace';
import { matchingCommands, SLASH_COMMANDS } from './slash-commands';
import { suggestionsFor } from '@/lib/demo/suggestions';

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
  demoKind = null,
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
  /**
   * `chats.demo_kind` (migration 0020), or null/undefined for an ordinary chat.
   * Drives the one demo-specific thing ChatSurface does: composer suggestion
   * chips. Centralised here rather than in each of the three places that render
   * a ChatSurface (the full page, the Rooms pane, a floating panel) so all three
   * get it for free instead of three separate wirings that could drift.
   */
  demoKind?: string | null;
}) {
  const router = useRouter();
  const [revoked, setRevoked] = useState(false);
  /**
   * One list, in real state.
   *
   * This was `useOptimistic`, and that was the bug behind "I send a message and
   * cannot see it". `useOptimistic` values are scoped to a transition and are
   * DISCARDED the moment it settles — and the transition here wrapped a
   * synchronous call, so it settled immediately. The draft appeared for a frame
   * and vanished, leaving the message's only route to the screen a Realtime
   * event that (see migration 0015) was never being published.
   *
   * A sent message is not speculative: the POST returns its real id. So it goes
   * into ordinary state and is reconciled by id, which is correct whether
   * Realtime is working, slow, or switched off entirely.
   */
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const landedRef = useRef(false);

  /**
   * Newest persisted `created_at` seen so far — the polling watermark.
   *
   * A ref rather than state because the poll reads it and must not be the
   * reason the interval is rebuilt. Pending drafts are excluded: their
   * client-side timestamp is ahead of the server's, and adopting it would skip
   * over rows written in between.
   */
  const newestAtRef = useRef<string>(
    initialMessages.filter((m) => !m.pending).at(-1)?.createdAt ?? new Date(0).toISOString(),
  );

  useEffect(() => {
    for (const m of messages) {
      if (!m.pending && !m.failed && m.createdAt > newestAtRef.current) {
        newestAtRef.current = m.createdAt;
      }
    }
  }, [messages]);

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
    () => new Set(messages.filter((m) => m.senderType === 'agent' && m.turnId).map((m) => m.turnId!)),
    [messages],
  );

  /**
   * Open at the bottom; animate only afterwards.
   *
   * A chat opens at the newest message, the way every chat app does — you
   * should not have to scroll past a month of history to see what was just
   * said. The first pass jumps the container directly rather than calling
   * `scrollIntoView({behavior:'smooth'})`, because smooth-scrolling 200
   * messages animates the whole backlog past the reader on open, which looks
   * like the page is loading badly.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!landedRef.current) {
      el.scrollTop = el.scrollHeight;
      landedRef.current = true;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

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

  /**
   * Polling fallback — the reason a reply arrives even when Realtime does not.
   *
   * Realtime is the fast path, not the correctness path. It can be silent for
   * reasons the browser cannot detect: a table missing from the publication
   * (exactly what migration 0015 fixes), a dropped socket, a proxy that killed
   * an idle WebSocket. `subscribe()` reports SUBSCRIBED in all of those cases,
   * so there is no error to surface and no retry to trigger — a broken live
   * feed and a quiet chat look identical.
   *
   * A chat where the agent's reply never appears until you reload is broken in
   * the only way users actually notice, so this closes it cheaply: one indexed
   * query for rows newer than the newest one already held, every few seconds.
   * When Realtime is working the poll finds nothing and costs almost nothing;
   * when it is not, the app still works.
   */
  useEffect(() => {
    const supabase = createClient();
    let stopped = false;

    async function poll() {
      // Read the watermark at call time, not from a dependency, so the interval
      // is created once rather than being torn down on every new message.
      const since = newestAtRef.current;
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_type, sender_id, content, created_at, turn_id')
        .eq('chat_id', chatId)
        .gt('created_at', since)
        .order('created_at', { ascending: true })
        .limit(50);

      if (stopped || error || !data || data.length === 0) return;

      const rows = data as unknown as {
        id: string; sender_type: 'user' | 'agent'; sender_id: string | null;
        content: string; created_at: string; turn_id: string;
      }[];

      setMessages((current) => {
        const known = new Set(current.map((m) => m.id));
        const fresh = rows
          .filter((r) => !known.has(r.id))
          .map((r) => {
            const who = r.sender_id ? people[r.sender_id] : undefined;
            return {
              id: r.id,
              senderType: r.sender_type,
              senderId: r.sender_id,
              senderName: r.sender_type === 'agent' ? 'Quorum' : who?.name ?? 'Someone',
              senderColor: who?.color ?? 'var(--agent)',
              content: r.content,
              createdAt: r.created_at,
              turnId: r.turn_id,
            } satisfies UiMessage;
          });
        return fresh.length === 0 ? current : [...current, ...fresh];
      });
    }

    const timer = setInterval(() => { void poll(); }, 2_500);
    return () => { stopped = true; clearInterval(timer); };
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

      setMessages((current) => [...current, draft]);

      try {
        const res = await fetch(`/api/chats/${chatId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, clientMessageId }),
        });
        if (!res.ok) throw new Error(await res.text());
        // The response carries the message's REAL id and turn id, synchronously,
        // long before the agent's reply exists (the turn runs in after()). So
        // the draft is promoted here rather than waiting for an event: the
        // user's own message is confirmed the moment the server confirms it,
        // with no dependency on Realtime at all.
        const json = (await res.json().catch(() => null)) as
          | { messageId?: string; turnId?: string }
          | null;

        setMessages((current) =>
          current.map((m) =>
            m.id === draft.id
              ? { ...m, id: json?.messageId ?? m.id, turnId: json?.turnId, pending: false }
              : m,
          ),
        );
      } catch {
        setMessages((current) =>
          current.map((m) => (m.id === draft.id ? { ...m, pending: false, failed: true } : m)),
        );
      }
    },
    [chatId, meId, people],
  );

  if (revoked) {
    return (
      <div className="border border-dashed border-border p-8 text-center">
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
      {/*
        `min-h-0` is load-bearing, not tidying.

        A flex item defaults to `min-height: auto`, which means it refuses to
        shrink below its content. So `flex-1 overflow-y-auto` does NOT scroll
        inside a flex column — the item grows to fit every message and pushes
        its parent past whatever max-height the parent was given. That is why
        the rooms page and the floating panel were both spilling down the page
        instead of scrolling: the container was capped and the child ignored it.
      */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-2">
        {messages.length === 0 && (
          <p className="py-12 text-center text-sm text-muted">No messages yet.</p>
        )}
        {messages.map((m) => {
          const turnId = m.turnId;
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
      <Composer chatId={chatId} onSend={send} people={people} meId={meId} demoKind={demoKind} />
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

  /**
   * The agent sits on the right in ink-edged monochrome with a machine label;
   * people sit on the left in their own colour. Two axes of difference, so it
   * survives being glanced at, and survives a colour-blind reader.
   *
   * The BUBBLE is right-aligned for the agent; the TEXT inside it is not. An
   * earlier version set `text-right` on the whole block, which put the bullets
   * of a list on the wrong side of their items and made every reply the agent
   * formatted read as broken. Alignment is a property of the bubble's place in
   * the column, not of the prose inside it.
   */
  return (
    <div className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'}`}>
      <div className="max-w-[85%]">
        <span
          className={`mb-1 block ${
            isAgent
              ? 'label text-right text-agent'
              : 'text-xs font-medium'
          }`}
          style={isAgent ? undefined : { color: message.senderColor }}
        >
          {isAgent ? 'Quorum' : isMe ? 'You' : message.senderName}
        </span>
        <div
          className={`px-3 py-2 text-left text-sm leading-relaxed ${
            isAgent
              ? 'border-l-2 border border-border bg-surface-raised text-foreground'
              : 'border border-border bg-surface'
          } ${message.pending ? 'opacity-50' : ''} ${
            message.failed ? 'border-danger' : ''
          }`}
          style={isAgent ? { borderLeftColor: 'var(--agent)' } : undefined}
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
          <span className="mt-1 block text-xs" style={{ color: 'var(--danger)' }}>
            Not sent.
          </span>
        )}
      </div>
    </div>
  );
}

interface MentionOption { handle: string; label: string; hint: string; color?: string }

/**
 * The `@` fragment being typed, or null.
 *
 * Matched only at the start of the message or after whitespace, so an email
 * address does not open a mention menu halfway through being typed.
 */
export function activeMention(value: string): string | null {
  const m = /(?:^|\s)@([\w-]*)$/.exec(value);
  return m ? m[1] : null;
}

function Composer({
  chatId, onSend, people, meId, demoKind,
}: {
  chatId: string;
  onSend: (text: string) => Promise<void>;
  people: Record<string, { name: string; color: string }>;
  meId: string;
  demoKind?: string | null;
}) {
  const suggestions = suggestionsFor(demoKind);
  const [value, setValue] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'attached' | 'error'; filename?: string; text: string } | null>(null);
  // Dismissible independently of `value`, so backspacing out of "/research "
  // after picking it does not reopen the menu on every keystroke.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commandSuggestions = menuDismissed ? [] : matchingCommands(value);

  /**
   * Who can be mentioned here: the agent first, then everyone else in the room.
   *
   * The agent leads the list because addressing it is the one mention that
   * CHANGES BEHAVIOUR — in a DM it is the difference between the agent
   * answering and staying silent — whereas mentioning a person is decoration
   * the app does not act on. Ordering by consequence rather than alphabetically.
   */
  const mentionable: MentionOption[] = useMemo(() => {
    const roster = Object.entries(people)
      .filter(([id]) => id !== meId)
      .map(([, p]) => ({ handle: p.name.split(' ')[0].toLowerCase(), label: p.name, hint: 'in this chat', color: p.color }));
    // Only `q` is offered. `@quorum` and `@agent` still work — see
    // GATE.mentionTokens — but listing three ways to say the same thing makes
    // the menu look like it has three entries when it has one, and the reader
    // has to read all three to discover that.
    return [
      { handle: 'q', label: 'Q', hint: 'the agent — makes it answer' },
      ...roster,
    ];
  }, [people, meId]);

  const fragment = menuDismissed ? null : activeMention(value);
  const mentionSuggestions =
    fragment === null
      ? []
      : mentionable
          .filter((o) => o.handle.startsWith(fragment.toLowerCase()))
          .slice(0, 6);

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

  function pickMention(handle: string) {
    // Replace only the fragment being typed, so mentioning someone mid-sentence
    // does not discard what came before it.
    setValue((cur) => cur.replace(/(?:@)([\w-]*)$/, `@${handle} `));
    setMenuDismissed(false);
    inputRef.current?.focus();
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setUploadingName(file.name);
    setNotice(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/chats/${chatId}/files`, { method: 'POST', body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'upload failed');
      // The agent finds files through file_list rather than being told about
      // them, so a message is a convenience, not the mechanism.
      setNotice({ kind: 'attached', filename: json.filename, text: 'Ask the agent about it.' });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'upload failed' });
    } finally {
      setUploading(false);
      setUploadingName(null);
    }
  }

  return (
    <div className="mt-4">
      {suggestions && suggestions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {/*
            Tapping SENDS immediately — through the same `onSend` the form
            below uses, not by filling the input for the user to press Enter.
            "Clicking one posts your message for real" is the entire design of
            this feature: there is no intermediate state where a chip's text
            sits in the box looking like it might still be scripted.
          */}
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => void onSend(text)}
              // NOT `.label` — that class uppercases and tracks its text,
              // which is right for a short tag like "DEMO" but wrong here: this
              // chip's text IS the message that gets sent verbatim, and
              // shouting it back in small caps misrepresents what will
              // actually appear in the transcript once tapped.
              className="border border-dashed border-border-strong px-2 py-1 text-left text-xs transition hover:bg-surface-raised"
              style={{ color: 'var(--c1)' }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
      {uploading && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" aria-hidden />
          Uploading {uploadingName}…
        </p>
      )}
      {notice && (
        <p
          className={`mb-2 flex items-center justify-between gap-2 border px-2.5 py-1.5 text-xs ${
            notice.kind === 'error'
              ? 'border-danger text-danger'
              : 'border-border-strong text-foreground'
          }`}
          aria-live="polite"
        >
          <span className="min-w-0 truncate">
            {notice.kind === 'attached' ? (
              <>
                <span aria-hidden>📎 </span>
                <strong className="font-medium">{notice.filename}</strong> attached — {notice.text}
              </>
            ) : (
              notice.text
            )}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-muted transition hover:text-foreground"
          >
            ×
          </button>
        </p>
      )}
      {/* The composer is the only place a user learns these exist, so both
          affordances are named here rather than in documentation nobody opens. */}
      <form onSubmit={submit} className="flex gap-2">
        <label
          className="grid cursor-pointer place-items-center border border-border bg-surface-raised px-3 text-sm transition hover:border-border-strong"
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
          {mentionSuggestions.length > 0 && (
            <ul
              role="listbox"
              className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden border border-border-strong bg-surface-raised shadow-lg"
            >
              {mentionSuggestions.map((o) => (
                <li key={o.handle}>
                  <button
                    type="button"
                    onClick={() => pickMention(o.handle)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-surface"
                  >
                    <span
                      className="grid h-5 w-5 shrink-0 place-items-center text-[10px] font-semibold"
                      style={{
                        background: o.color ?? 'var(--ink)',
                        color: o.color ? 'var(--on-paper)' : 'var(--on-ink)',
                      }}
                      aria-hidden
                    >
                      {o.label.charAt(0).toUpperCase()}
                    </span>
                    <span className="font-mono text-foreground">@{o.handle}</span>
                    <span className="truncate text-muted">{o.label} · {o.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {commandSuggestions.length > 0 && (
            <ul
              role="listbox"
              // z-50: the floating-panel host sits at z-40 (see
              // floating-panels/host.tsx). Without an explicit z-index here this
              // popup renders BEHIND an open panel — found by actually opening
              // one and typing "/" on the page underneath it, not by inspecting
              // either component in isolation.
              className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden border border-border-strong bg-surface-raised shadow-lg"
            >
              {commandSuggestions.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => pickCommand(c.usage)}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs transition hover:bg-surface-raised"
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
            placeholder="Message — @ to mention, / for commands"
            className="w-full border border-border bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-border-strong"
          />
        </div>
        <button
          type="submit"
          disabled={!value.trim()}
          className="label border border-border-strong px-4 transition hover:bg-surface-raised disabled:opacity-40"
        >
          Send
        </button>
      </form>
      {commandSuggestions.length === 0 &&
        SLASH_COMMANDS.some((c) => value.trim().toLowerCase().startsWith(c.name)) && (
          <p className="mt-2 text-xs text-muted">
            {SLASH_COMMANDS.find((c) => value.trim().toLowerCase().startsWith(c.name))?.description}
          </p>
        )}
    </div>
  );
}
