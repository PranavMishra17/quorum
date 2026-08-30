import { after, NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';
import { runTurn } from '@/lib/agent/orchestrator';
import { parseResearchCommand, runResearchTurn } from '@/lib/agent/research';

/**
 * Send a message, then run the agent turn.
 *
 * Two things make this route what it is:
 *
 * 1. **The write goes through an RPC, not through `.from().insert()`.**
 *    `supabase-js` has no multi-statement transaction, so a client-side
 *    "check for a duplicate, then insert" is a race rather than a check. The
 *    function does `ON CONFLICT DO NOTHING` inside one transaction and returns
 *    the ORIGINAL `turn_id` on a duplicate, which is what stops a retried
 *    request producing a second agent reply.
 *
 * 2. **The agent turn runs in `after()`.** The user's message is persisted and
 *    acknowledged immediately; the reply arrives over Realtime when it is
 *    ready. Holding the response open for the model call would make send
 *    latency the model's latency, and would put the whole turn on the
 *    serverless timeout cliff.
 */

/**
 * The agent turn runs in `after()`, and `after()` work counts toward this
 * function's duration — so this number is the real ceiling on a turn, not a
 * formality. It was 60 while `TIERS.reason.timeoutMs` was 240 and the research
 * budget 180, which meant both were budgets for a container four times larger
 * than the one they ran in.
 *
 * It is a LITERAL and not `PLATFORM.turnRouteMaxDurationSeconds`, because Next
 * reads route segment config statically and rejects an imported expression
 * ("Invalid segment configuration export detected") — which the build says
 * plainly, and which is the only reason this is duplicated. `tests/config.test.ts`
 * asserts the literal here equals the config value, so the duplication cannot
 * drift.
 */
export const maxDuration = 300;

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

  let body: { content?: unknown; clientMessageId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const clientMessageId =
    typeof body.clientMessageId === 'string' ? body.clientMessageId : '';

  if (!content) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }
  if (content.length > 20_000) {
    return NextResponse.json({ error: 'content is too long' }, { status: 400 });
  }
  if (!clientMessageId) {
    // Required, not optional. Without it a retry is indistinguishable from a
    // second message, and the agent answers twice.
    return NextResponse.json(
      { error: 'clientMessageId is required for idempotency' },
      { status: 400 },
    );
  }

  // Session-bound client: the RPC is SECURITY DEFINER and authorises both axes
  // itself, but the call still travels as the user.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('send_message_and_start_turn', {
    p_chat_id: chatId,
    p_content: content,
    p_client_message_id: clientMessageId,
  });

  if (error) {
    // The function raises 42501 for both "not a member" and "not cleared".
    // Deliberately one message: distinguishing them would disclose which axis
    // failed, and therefore that the chat exists.
    const denied = error.code === '42501' || /not authorised/i.test(error.message);
    return NextResponse.json(
      { error: denied ? 'not authorised for this chat' : 'could not send message' },
      { status: denied ? 403 : 500 },
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    message_id: string; turn_id: string; is_duplicate: boolean;
  };

  // A duplicate delivery must not start a second turn. The original is either
  // already running or already finished.
  if (!row.is_duplicate) {
    const requestId = randomUUID();
    // `/research <question>` runs a different, more expensive turn type: the
    // gate is bypassed (asking directly is the clearest possible request for a
    // reply) and the step budget is larger. Everything else — the rate limit,
    // the tool bounds, D-022 — is shared, because a second turn type with its
    // own copies of those would be a second place for them to drift.
    const research = parseResearchCommand(content);
    after(async () => {
      try {
        if (research) {
          await runResearchTurn({
            chatId,
            actorId,
            turnId: row.turn_id,
            requestId,
            messageId: row.message_id,
            question: research,
          });
          return;
        }
        await runTurn({
          chatId,
          actorId,
          turnId: row.turn_id,
          requestId,
          messageId: row.message_id,
        });
      } catch (err) {
        // runTurn already records its own failures. This catch exists so an
        // unexpected throw cannot become an unhandled rejection that takes the
        // function down after the user has been told their message was sent.
        console.error('[turn] unhandled failure', {
          chatId, turnId: row.turn_id, requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return NextResponse.json(
    {
      messageId: row.message_id,
      turnId: row.turn_id,
      duplicate: row.is_duplicate,
    },
    { status: row.is_duplicate ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
