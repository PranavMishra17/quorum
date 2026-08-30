import { NextResponse, type NextRequest } from 'next/server';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';

/**
 * Grant or revoke a clearance.
 *
 * Like every other write route here, this performs no authorisation of its own.
 * `grant_clearance()` and `revoke_clearance()` are SECURITY DEFINER and enforce
 * the rule themselves — you cannot grant above your own level — because that
 * check reads the CALLER's grants, which a policy on the row being inserted
 * cannot express.
 */
export async function POST(request: NextRequest) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    throw err;
  }

  let body: { action?: unknown; userId?: unknown; clearanceId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const action = body.action === 'grant' || body.action === 'revoke' ? body.action : null;
  const userId = typeof body.userId === 'string' ? body.userId : null;
  const clearanceId = typeof body.clearanceId === 'string' ? body.clearanceId : null;

  if (!action || !userId || !clearanceId) {
    return NextResponse.json(
      { error: 'action (grant|revoke), userId and clearanceId are required' },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc(
    action === 'grant' ? 'grant_clearance' : 'revoke_clearance',
    { p_user_id: userId, p_clearance_id: clearanceId },
  );

  if (error) {
    // 42501 is the delegation rule refusing. Its message is written for a
    // human — "cannot grant a clearance above your own" — so it is passed
    // through rather than flattened into a generic 403.
    const status = error.code === '42501' ? 403 : error.code === '23503' ? 404 : 500;
    return NextResponse.json(
      { error: status === 500 ? 'could not update clearance' : error.message },
      { status },
    );
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
