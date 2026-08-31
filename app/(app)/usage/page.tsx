import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';

export const metadata = { title: 'Usage' };

/**
 * Token and cost accounting.
 *
 * Reads `llm_calls` through the session-bound client, so the totals are
 * scoped by RLS to chats the viewer can actually access. There is no global
 * "admin" view, and that is deliberate: a spend dashboard that aggregates
 * across chats the viewer cannot read would disclose that those chats exist and
 * roughly how busy they are.
 */
export default async function UsagePage() {
  await requireActor();
  const supabase = await createClient();

  const [{ data: calls }, { data: chats }] = await Promise.all([
    supabase
      .from('llm_calls')
      .select('chat_id, purpose, model, status, input_tokens, output_tokens, cost_estimate, created_at')
      .order('created_at', { ascending: false })
      .limit(2000),
    supabase.from('chats').select('id, name, type'),
  ]);

  const rows = (calls ?? []) as unknown as {
    chat_id: string; purpose: string; model: string; status: string;
    input_tokens: number | null; output_tokens: number | null;
    cost_estimate: string | null; created_at: string;
  }[];

  const chatNames = new Map(
    ((chats ?? []) as unknown as { id: string; name: string | null; type: string }[])
      .map((c) => [c.id, c.name ?? (c.type === 'dm' ? 'Direct message' : 'Chat')]),
  );

  const cost = (r: { cost_estimate: string | null }) => Number(r.cost_estimate ?? 0);
  const tokens = (r: { input_tokens: number | null; output_tokens: number | null }) =>
    (r.input_tokens ?? 0) + (r.output_tokens ?? 0);

  const total = rows.reduce((n, r) => n + cost(r), 0);
  const totalTokens = rows.reduce((n, r) => n + tokens(r), 0);
  const failed = rows.filter((r) => r.status === 'failed').length;

  const byPurpose = group(rows, (r) => r.purpose);
  const byChat = group(rows, (r) => chatNames.get(r.chat_id) ?? 'Unknown');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Usage</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          Every model call writes a row before it is made, so a call that
          crashed or timed out still appears here. Totals cover only the chats
          you can access — a dashboard that aggregated across chats you cannot
          read would disclose that they exist.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Total cost" value={`$${total.toFixed(4)}`} />
        <Stat label="Tokens" value={totalTokens.toLocaleString()} />
        <Stat label="Calls" value={String(rows.length)} />
        <Stat label="Failed" value={String(failed)} tone={failed > 0 ? 'danger' : undefined} />
      </div>

      {rows.length === 0 ? (
        <p className="border border-dashed border-border p-8 text-center text-sm text-muted">
          No model calls yet.
        </p>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <Breakdown title="By purpose" rows={byPurpose} />
          <Breakdown title="By chat" rows={byChat} />
        </div>
      )}

      <Link href="/chats" className="inline-block text-xs text-foreground underline">
        Back to chats
      </Link>
    </div>
  );
}

function group<T extends { cost_estimate: string | null; input_tokens: number | null; output_tokens: number | null }>(
  rows: T[],
  key: (r: T) => string,
) {
  const map = new Map<string, { calls: number; tokens: number; cost: number }>();
  for (const r of rows) {
    const k = key(r);
    const cur = map.get(k) ?? { calls: 0, tokens: 0, cost: 0 };
    cur.calls += 1;
    cur.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    cur.cost += Number(r.cost_estimate ?? 0);
    map.set(k, cur);
  }
  return [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone === 'danger' ? 'text-danger' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function Breakdown({
  title, rows,
}: {
  title: string;
  rows: [string, { calls: number; tokens: number; cost: number }][];
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      <div className="scroll-x border border-border">
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="p-2 text-left font-normal">Name</th>
              <th className="p-2 text-right font-normal">Calls</th>
              <th className="p-2 text-right font-normal">Tokens</th>
              <th className="p-2 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, s]) => (
              <tr key={name} className="border-b border-border last:border-0">
                <td className="p-2 font-mono">{name}</td>
                <td className="p-2 text-right tabular-nums">{s.calls}</td>
                <td className="p-2 text-right tabular-nums">{s.tokens.toLocaleString()}</td>
                <td className="p-2 text-right tabular-nums">${s.cost.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
