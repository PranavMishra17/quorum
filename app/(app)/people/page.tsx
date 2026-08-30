import { createClient, requireActor } from '@/lib/db/server';
import { ClearanceControls, type DirectoryPerson, type Rung } from '@/app/_components/clearance-controls';

export const metadata = { title: 'People' };

/**
 * The directory, and the clearance-granting surface.
 *
 * This page exists because a Phase 2 sanity check found that `user_clearances`
 * had no write path at all: a user who signed in fresh held nothing, could not
 * see or create a gated chat, and the second authorisation axis was unreachable
 * outside the seed script. D-003 said grants were administrative; that had been
 * implemented as "nobody can grant anything".
 *
 * The rule enforced in `grant_clearance()` is the one real systems use: **you
 * cannot grant a clearance you do not hold yourself.** The UI hides what the
 * viewer cannot grant, but the database is what refuses it —
 * `tests/authorization/clearance-grants.test.ts` proves a level-2 user cannot
 * mint level 3 no matter what the page offers.
 */
export default async function PeoplePage() {
  const actor = await requireActor();
  const supabase = await createClient();

  const [{ data: profiles }, { data: grants }, { data: ladder }] = await Promise.all([
    supabase.from('profiles').select('id, display_name, color').order('display_name'),
    supabase.from('user_clearances').select('user_id, clearances(id, name, level)'),
    supabase.from('clearances').select('id, key, name, level').order('level'),
  ]);

  const rungs = ((ladder ?? []) as unknown as Rung[]);

  const byUser = new Map<string, Rung[]>();
  for (const g of (grants ?? []) as unknown as
    { user_id: string; clearances: Rung | null }[]) {
    if (!g.clearances) continue;
    const list = byUser.get(g.user_id) ?? [];
    list.push(g.clearances);
    byUser.set(g.user_id, list);
  }

  const people: DirectoryPerson[] = ((profiles ?? []) as unknown as
    { id: string; display_name: string; color: string }[]
  ).map((p) => ({
    id: p.id,
    name: p.display_name,
    color: p.color,
    clearances: (byUser.get(p.id) ?? []).sort((a, b) => a.level - b.level),
  }));

  const myTop = Math.max(
    -1,
    ...(byUser.get(actor.id) ?? []).map((c) => c.level),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">People</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          Clearance is the second authorisation axis: independent of membership,
          and required as well as it. You can grant any rung{' '}
          <strong>at or below your own</strong> — never above, because a user who
          could mint a higher clearance could read everything through whoever
          they granted it to.
        </p>
      </div>

      <ClearanceControls
        people={people}
        rungs={rungs}
        meId={actor.id}
        myTopLevel={myTop}
      />
    </div>
  );
}
