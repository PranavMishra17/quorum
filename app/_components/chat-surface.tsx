'use client';

import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from 'react';
import { createClient } from '@/lib/db/browser';
import { MessageContent } from './message-content';

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
}

export function ChatSurface({
  chatId,
  meId,
  initialMessages,
  people,
}: {
  chatId: string;
  meId: string;
  initialMessages: UiMessage[];
  people: Record<string, { name: string; color: string }>;
}) {
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [optimistic, addOptimistic] = useOptimistic(
    messages,
    (current, next: UiMessage) => [...current, next],
  );
  const [, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [optimistic.length]);

  /**
   * Realtime.
   *
   * A known limitation, stated rather than hidden: Supabase Realtime evaluates
   * row-level security when the subscription is established and caches that
   * result for the socket's lifetime. A member removed mid-session keeps
   * receiving messages on an already-open socket until it drops. The fix is to
   * force-close their channels on removal, which is Phase 2 work; until then
   * the README says "next read", not "immediately".
   */
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`chat:${chatId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
        (payload) => {
          const row = payload.new as {
            id: string; sender_type: 'user' | 'agent'; sender_id: string | null;
            content: string; created_at: string;
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
      } catch {
        setMessages((current) => [...current, { ...draft, pending: false, failed: true }]);
      }
    },
    [chatId, meId, people, addOptimistic],
  );

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {optimistic.length === 0 && (
          <p className="py-12 text-center text-sm text-muted">No messages yet.</p>
        )}
        {optimistic.map((m) => (
          <MessageRow key={m.id} message={m} isMe={m.senderId === meId} />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer onSend={send} />
    </div>
  );
}

function MessageRow({ message, isMe }: { message: UiMessage; isMe: boolean }) {
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
        {message.failed && (
          <span className="mt-1 block text-xs text-danger">Not sent.</span>
        )}
      </div>
    </div>
  );
}

function Composer({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [value, setValue] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    setValue('');
    await onSend(text);
  }

  return (
    <form onSubmit={submit} className="mt-4 flex gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Message — mention @quorum to address the agent directly"
        className="flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-accent"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="rounded-lg border border-border bg-surface-raised px-4 text-sm transition hover:border-accent disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}
