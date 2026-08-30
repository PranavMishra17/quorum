import { NextResponse, type NextRequest } from 'next/server';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';

/**
 * Membership management.
 *
 * This handler performs NO authorisation of its own. Every operation below is
 * an ordinary `.from('chat_members')` write through the session-bound client,
 * so the policies in migration 0003 decide what happens:
 *
 *   - admins may add, remove, and promote
 *   - anyone may request to join a chat they can discover
 *   - anyone may set their OWN row to `removed`, and nothing else about it
 *
 * A non-admin attempting a privileged write does not get a 403 from code here;
 * the database returns zero affected rows or raises, and that is translated
 * below. Writing the checks twice would mean two things to keep in step, and
 * the copy in TypeScript would be the one that drifts.
 */

interface Body {
  action?: unknown;
  userId?: unknown;
  role?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;

  let actorId: string;
  try {
    actorId = (await requireActor()).id;
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    throw err;
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const userId = typeof body.userId === 'string' ? body.userId : null;
  const supabase = await createClient();

  switch (action) {
    // -----------------------------------------------------------------------
    case 'request': {
      // Ask to join. `requested` is not access — it is a pending row with no
      // read rights, and the policies enforce that.
      const { error } = await supabase.from('chat_members').insert({
        chat_id: chatId, user_id: actorId, status: 'requested', role: 'member',
      });
      if (error) return denied(error);
      return ok({ status: 'requested' });
    }

    // -----------------------------------------------------------------------
    case 'leave': {
      const { data, error } = await supabase
        .from('chat_members')
        .update({ status: 'removed', removed_at: new Date().toISOString() })
        .eq('chat_id', chatId)
        .eq('user_id', actorId)
        .select('user_id');
      if (error) return denied(error);
      if (!data?.length) return NextResponse.json({ error: 'not a member' }, { status: 404 });
      await announceRevocation(chatId, actorId);
      return ok({ status: 'removed' });
    }

    // -----------------------------------------------------------------------
    case 'approve':
    case 'add': {
      if (!userId) return badRequest('userId is required');
      const { data, error } = await supabase
        .from('chat_members')
        .upsert(
          {
            chat_id: chatId, user_id: userId, status: 'member',
            role: 'member', joined_at: new Date().toISOString(),
          },
          { onConflict: 'chat_id,user_id' },
        )
        .select('user_id');
      if (error) return denied(error);
      if (!data?.length) return forbidden();
      return ok({ status: 'member' });
    }

    // -----------------------------------------------------------------------
    case 'remove': {
      if (!userId) return badRequest('userId is required');
      const { data, error } = await supabase
        .from('chat_members')
        .update({ status: 'removed', removed_at: new Date().toISOString() })
        .eq('chat_id', chatId)
        .eq('user_id', userId)
        .select('user_id');
      if (error) return denied(error);
      if (!data?.length) return forbidden();

      // T11. See announceRevocation() for what this does and does not do.
      await announceRevocation(chatId, userId);
      return ok({ status: 'removed' });
    }

    // -----------------------------------------------------------------------
    case 'promote':
    case 'demote': {
      if (!userId) return badRequest('userId is required');
      const role = action === 'promote' ? 'admin' : 'member';
      const { data, error } = await supabase
        .from('chat_members')
        .update({ role })
        .eq('chat_id', chatId)
        .eq('user_id', userId)
        .select('user_id');
      if (error) return denied(error);
      if (!data?.length) return forbidden();
      return ok({ role });
    }

    default:
      return badRequest('action must be one of request, leave, add, approve, remove, promote, demote');
  }
}

/**
 * T11 — Realtime caches its RLS evaluation for the socket's lifetime.
 *
 * A removed member holding an already-open subscription keeps receiving new
 * messages until that socket drops. Their next *read* is refused, because RLS
 * runs again — but a live channel is not a read.
 *
 * This broadcasts on a channel keyed to the removed user so their browser can
 * tear down its subscriptions and re-render as a non-member.
 *
 * Be clear about what this is: **cooperative, not enforcement.** A modified
 * client could ignore the broadcast and hold the socket open. What it would
 * receive is limited to new messages on that one channel until the socket
 * drops, and every other read — history, roster, files, memory — is already
 * refused. The honest guarantee is the one the README states: access ends on
 * the next read. This narrows the live window; it does not close it.
 *
 * Closing it properly means terminating the socket server-side, which Supabase
 * does not currently expose.
 */
async function announceRevocation(chatId: string, userId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const channel = supabase.channel(`membership:${userId}`);
    await channel.send({
      type: 'broadcast',
      event: 'revoked',
      payload: { chatId },
    });
    await supabase.removeChannel(channel);
  } catch {
    // Best effort. Failing to notify must not fail the removal — the removal is
    // the thing that actually matters, and it has already happened.
  }
}

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

const forbidden = () =>
  NextResponse.json({ error: 'not permitted' }, { status: 403 });

function denied(error: { code?: string; message: string }) {
  // 42501 is an RLS refusal; 23505 is "already there", which is not a failure
  // worth surfacing as one.
  if (error.code === '23505') return ok({ status: 'unchanged' });
  const isPolicy = error.code === '42501' || /row-level security/i.test(error.message);
  return NextResponse.json(
    { error: isPolicy ? 'not permitted' : 'could not update membership' },
    { status: isPolicy ? 403 : 500 },
  );
}
