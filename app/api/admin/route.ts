import { NextResponse, type NextRequest } from 'next/server';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';
import { adminModeEnabled } from '@/lib/auth/admin-mode';
import { untypedDb } from '@/lib/connectors/rpc';

/**
 * Admin mode actions — self-granting clearance, self-joining groups.
 *
 * This handler holds the secret that arms migration 0016's functions and passes
 * it through; it never reaches the browser. That is the whole reason the
 * mutation is a route rather than a direct `supabase.rpc()` from a client
 * component: a browser holds the publishable key, and if the browser could arm
 * these functions then the publishable key could, and the gate would be
 * decoration.
 *
 * Three conditions must hold for anything here to work, and they fail
 * independently:
 *
 *   1. `adminModeEnabled()` — non-production plus an explicit opt-in flag.
 *      Fails here, with a 404, so the route does not even admit to existing.
 *   2. `ADMIN_MODE_SECRET` is set in server env.
 *   3. `private.admin_mode_secret` holds a matching row. Fails in SQL, so a
 *      production database refuses regardless of what this file believes.
 *
 * Every successful action is audited. The clearance itself carries no marker
 * saying it was self-issued, so without the event trail a reviewer would have
 * no way to tell a demonstrated rule from a rigged one.
 */

const ACTIONS = new Set(['grant', 'revoke', 'join', 'leave']);

const RPC: Record<string, { fn: string; arg: string }> = {
  grant: { fn: 'dev_self_grant', arg: 'p_clearance_id' },
  revoke: { fn: 'dev_self_revoke', arg: 'p_clearance_id' },
  join: { fn: 'dev_self_join', arg: 'p_chat_id' },
  leave: { fn: 'dev_self_leave', arg: 'p_chat_id' },
};

export async function POST(request: NextRequest) {
  // A 404 rather than a 403: a disabled feature should not confirm it is a
  // feature. This is the same reasoning as the dev-login route.
  if (!adminModeEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    await requireActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    throw err;
  }

  const secret = process.env.ADMIN_MODE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'ADMIN_MODE_SECRET is not set, so admin mode is not armed' },
      { status: 501 },
    );
  }

  let body: { action?: unknown; targetId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const targetId = typeof body.targetId === 'string' ? body.targetId : '';

  if (!ACTIONS.has(action) || !targetId) {
    return NextResponse.json(
      { error: 'action must be one of grant, revoke, join, leave, with a targetId' },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const spec = RPC[action];

  const { error } = await untypedDb(supabase).rpc(spec.fn, {
    [spec.arg]: targetId,
    p_secret: secret,
  });

  if (error) {
    // Name which gate is closed. These fail for genuinely different reasons and
    // "action failed" sends a developer looking in the wrong place — which is
    // exactly what happened the first time this ran against a database that had
    // not had migration 0016 pushed to it yet.
    //
    //   PGRST202  PostgREST cannot find the function in its schema cache, i.e.
    //             the migration is not pushed. NOT the Postgres code 42883 —
    //             the request never reaches Postgres to produce one.
    //   42501     it exists and refused: the secret row is absent or wrong.
    if (error.code === 'PGRST202' || error.code === '42883') {
      return NextResponse.json(
        {
          error:
            'admin mode is not installed on this database — run `supabase db push` to apply migration 0016',
        },
        { status: 501 },
      );
    }
    if (error.code === '42501') {
      return NextResponse.json(
        {
          error:
            'admin mode is installed but not armed — insert a row into private.admin_mode_secret matching ADMIN_MODE_SECRET',
        },
        { status: 403 },
      );
    }
    console.error('[admin] action failed', { code: error.code, message: error.message });
    return NextResponse.json({ error: 'action failed' }, { status: 500 });
  }

  // No audit write here on purpose: the SQL functions write it themselves, so
  // it cannot be skipped by a caller that forgets. The first draft of this file
  // DID write the audit, into `agent_events` — a table with no client insert
  // policy and a NOT NULL chat_id — so the write failed silently and the
  // feature would have shipped claiming a trail that did not exist.
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
