'use client';

import { useMemo, useState } from 'react';
import { ClearanceStamp } from './clearance';
import { isRetrievable, withheldReason, type MyMemoryItem } from '@/lib/memory/mine';

export interface EnrichedMemoryItem extends MyMemoryItem {
  originChatName: string | null;
  originChatKnown: boolean;
  otherNames: string[];
}

type Filter = 'all' | 'active' | 'withheld';

/**
 * Everything the agent has recorded about you, with its scope made visible.
 *
 * "Scope" is the point of this page over a plain list. A fact by itself
 * ("reviews contracts on Fridays") tells you what is known; the audience tells
 * you where it can be repeated. Those are answered by different fields on
 * purpose — `sourceType` for provenance, `audienceSize`/room for reach,
 * `status` for whether it is even in play — and the tags render all three so
 * none of them hides behind the others.
 */
export function MemoryList({ items }: { items: EnrichedMemoryItem[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'active') return items.filter(isRetrievable);
    return items.filter((i) => !isRetrievable(i));
  }, [items, filter]);

  const counts = useMemo(
    () => ({
      all: items.length,
      active: items.filter(isRetrievable).length,
      withheld: items.filter((i) => !isRetrievable(i)).length,
    }),
    [items],
  );

  return (
    <div className="space-y-6">
      <header className="border-b border-border pb-5">
        <h1 className="font-display text-2xl font-semibold">Memory</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Everything the agent has recorded about you, across every chat. Not
          everything here is in use — a candidate below the confidence bar, or
          one learned while reading an untrusted document, is kept but never
          retrieved. Nothing is ever deleted here; superseded facts stay
          visible so the history of what was believed, and when, is auditable.
        </p>
      </header>

      <div className="flex gap-px border-b border-border">
        {(['all', 'active', 'withheld'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`label border-b-2 px-4 pb-2 pt-1 transition ${
              filter === f
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted hover:text-foreground'
            }`}
          >
            {f === 'all' ? 'All' : f === 'active' ? 'In use' : 'Withheld'}{' '}
            <span className="ml-1.5 opacity-60">{counts[f]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="border border-dashed border-border p-8 text-center text-sm text-muted">
          {items.length === 0
            ? 'Nothing recorded yet. The agent learns from what you tell it in conversation, never from what it infers you might mean.'
            : 'Nothing matches this filter.'}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {filtered.map((item) => (
            <MemoryRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryRow({ item }: { item: EnrichedMemoryItem }) {
  const inUse = isRetrievable(item);
  const reason = withheldReason(item);

  return (
    <li className="p-4">
      <p className="text-sm leading-relaxed">{item.content}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Tag tone={item.sourceType === 'stated' ? 'plain' : 'muted'}>
          {item.sourceType === 'stated' ? 'You said this' : 'Inferred about you'}
        </Tag>
        <Tag tone={inUse ? 'plain' : 'muted'}>{inUse ? 'In use' : 'Withheld'}</Tag>
        <ClearanceStamp level={item.clearanceLevel} />
        <Tag tone="muted">
          {item.audienceSize} {item.audienceSize === 1 ? 'person' : 'people'} could hear it repeated
        </Tag>
        {item.expiresAt && (
          <Tag tone="muted">expires {new Date(item.expiresAt).toLocaleDateString()}</Tag>
        )}
      </div>

      <p className="mt-2 text-xs text-muted">
        Learned in{' '}
        {item.originChatKnown ? (
          <a href={`/people?open=${item.originChatId}`} className="underline underline-offset-2 hover:text-foreground">
            {item.originChatName ?? 'a chat'}
          </a>
        ) : (
          <span>a chat you can no longer open</span>
        )}
        {item.otherNames.length > 0 && <> — with {item.otherNames.join(', ')}</>}
        {' · '}
        {new Date(item.createdAt).toLocaleDateString()}
      </p>

      {reason && <p className="mt-1 text-xs italic text-muted">{reason}</p>}
    </li>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'plain' | 'muted' }) {
  return (
    <span
      className={`label border px-1.5 py-0.5 ${
        tone === 'plain' ? 'border-border-strong text-foreground' : 'border-border text-muted'
      }`}
    >
      {children}
    </span>
  );
}
