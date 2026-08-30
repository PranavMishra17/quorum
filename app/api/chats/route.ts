import { NextResponse, type NextRequest } from 'next/server';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';

/**
 * Create a chat.
 *
 * All validation and both writes happen inside `create_chat()` (migration
 * 0011), for the same reason sending a message goes through an RPC: a chat and
 * its members must be created in one transaction. Split in two, a failure
 * between them leaves a chat with nobody in it — which is precisely the
 * zero-active-members case the memory fail-closed guard exists for.
 *
 * This handler therefore does no authorisation of its own. It shapes the
 * request and translates errors; the database decides.
 */

const CHAT_TYPES = new Set(['dm', 'group', 'agent']);

export async function POST(request: NextRequest) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    throw err;
  }

  let body: {
    type?: unknown; name?: unknown; memberIds?: unknown; requiredClearanceId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const type = typeof body.type === 'string' ? body.type : '';
  if (!CHAT_TYPES.has(type)) {
    return NextResponse.json(
      { error: 'type must be one of dm, group, agent' },
      { status: 400 },
    );
  }

  const memberIds = Array.isArray(body.memberIds)
    ? body.memberIds.filter((m): m is string => typeof m === 'string')
    : [];
  const name = typeof body.name === 'string' ? body.name.slice(0, 120) : null;
  const requiredClearanceId =
    typeof body.requiredClearanceId === 'string' && body.requiredClearanceId
      ? body.requiredClearanceId
      : null;

  const supabase = await createClient();
  // `type` is validated against CHAT_TYPES above; name and clearance are
  // genuinely optional, which generated RPC arg types do not model.
  const { data, error } = await supabase.rpc('create_chat', {
    p_type: type,
    p_name: name,
    p_member_ids: memberIds,
    p_required_clearance_id: requiredClearanceId,
  } as never);

  if (error) {
    // 23514 is a CHECK violation — the shape rules (a DM has two people, a
    // group needs a name). Those are the user's mistake and worth reporting
    // verbatim, because the message is written for a human.
    // 42501 is authorisation. 23503 is an unknown participant or clearance.
    const status = error.code === '42501' ? 403 : error.code === '23514' ? 400 : 500;
    return NextResponse.json(
      { error: status === 500 ? 'could not create chat' : error.message },
      { status },
    );
  }

  return NextResponse.json(
    { chatId: data as unknown as string },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
