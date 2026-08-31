import { NextResponse, type NextRequest } from 'next/server';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';

/**
 * Open the direct message with one person, creating it only if it does not
 * already exist.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE EXISTS AT ALL
 *
 * `POST /api/chats` can already make a DM, and that was the only way to reach
 * one — through a "New chat" form, picking a type, then picking a person. Which
 * meant the obvious action in a directory ("click someone to talk to them") had
 * no implementation, and doing it twice would silently create a SECOND DM with
 * the same person. Two DMs between the same pair is not a cosmetic problem: a
 * memory item learned in one has an audience snapshot that authorises it in the
 * other, so the history a user thinks of as "our conversation" is split across
 * two rooms with no way to tell them apart in a list.
 *
 * So: find-then-create, and the find is the important half.
 *
 * ---------------------------------------------------------------------------
 * THE LOOKUP RUNS AS THE USER
 *
 * Every query here goes through the session-bound client, so RLS decides what
 * comes back. A DM the caller is not in is not found, and the create path is
 * `create_chat()`, which authorises itself. This route therefore makes no
 * authorisation decision of its own — it shapes a request and translates
 * errors, exactly like `POST /api/chats`.
 *
 * There is a race: two simultaneous requests could both miss and both create.
 * It is not worth a table constraint here — a DM has no natural unique key
 * without a canonical member-pair column, adding one is a schema change to
 * `chats`, and the cost of losing the race is one duplicate room rather than
 * anything unsafe. Recorded rather than hidden.
 */

export async function POST(request: NextRequest) {
  let actorId: string;
  try {
    actorId = (await requireActor()).id;
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    throw err;
  }

  let body: { userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const otherId = typeof body.userId === 'string' ? body.userId : '';
  if (!otherId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }
  if (otherId === actorId) {
    // A DM with yourself is a CHECK violation in create_chat anyway; refusing
    // here gives a message a human wrote.
    return NextResponse.json(
      { error: 'to talk to the agent alone, open Q instead' },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // Every DM the caller is in. RLS already limits this to their own rows.
  const { data: mine, error: mineError } = await supabase
    .from('chat_members')
    .select('chat_id, chats!inner(type)')
    .eq('user_id', actorId)
    .eq('status', 'member')
    .eq('chats.type', 'dm');

  if (mineError) {
    console.error('[dm] membership lookup failed', { code: mineError.code });
    return NextResponse.json({ error: 'could not open the conversation' }, { status: 500 });
  }

  const dmIds = ((mine ?? []) as unknown as { chat_id: string }[]).map((r) => r.chat_id);

  if (dmIds.length > 0) {
    // Which of those does the other person share? One query, not one per chat.
    const { data: shared } = await supabase
      .from('chat_members')
      .select('chat_id')
      .eq('user_id', otherId)
      .eq('status', 'member')
      .in('chat_id', dmIds)
      .limit(1);

    const existing = ((shared ?? []) as unknown as { chat_id: string }[])[0];
    if (existing) {
      return NextResponse.json(
        { chatId: existing.chat_id, created: false },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  const { data, error } = await supabase.rpc('create_chat', {
    p_type: 'dm',
    p_name: null,
    p_member_ids: [otherId],
    p_required_clearance_id: null,
  } as never);

  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '23514' ? 400 : 500;
    return NextResponse.json(
      { error: status === 500 ? 'could not open the conversation' : error.message },
      { status },
    );
  }

  return NextResponse.json(
    { chatId: data as unknown as string, created: true },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
