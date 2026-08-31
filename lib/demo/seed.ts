import { createClient } from '@/lib/db/server';
import { sampleContractPdf } from './sample-pdf';

/**
 * Bootstrap the caller's demo world, if they do not have one yet.
 *
 * Called from the same two places `ensureProfile()` is — `app/auth/
 * callback/route.ts` and `app/auth/dev/route.ts` — immediately after it, so a
 * demo world exists the first time a new user reaches `/chats`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEVER USES THE SERVICE ROLE
 *
 * Every write here goes through the SESSION-BOUND client. `ensure_demo_world()`
 * is a SECURITY DEFINER function reachable by any authenticated user and scoped
 * to `auth.uid()` internally (see migration 0020) — calling it through the
 * ordinary client is exactly how `grant_clearance()` and every other
 * SECURITY DEFINER RPC in this codebase is called. The one thing that cannot go
 * through SQL — writing bytes to Storage — still runs as the signed-in user,
 * because by the time it happens they are already a real member of the room
 * `ensure_demo_world()` just created for them, and the storage policy already
 * admits a chat member. There is no path here that needed the service role, so
 * there is no path here that used it.
 *
 * Failure is swallowed on purpose: a broken demo world must never be the
 * reason a real sign-in fails. It is logged loudly so the gap is visible in
 * server logs without being visible to the user as an error.
 */
export async function ensureDemoWorld(): Promise<void> {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase.rpc('ensure_demo_world');
    if (error) {
      console.error('[demo] ensure_demo_world failed', { code: error.code, message: error.message });
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { created: boolean; contract_chat_id: string | null; group_chat_id: string | null }
      | undefined;

    if (!row?.created || !row.contract_chat_id) return; // nothing new, or personas not seeded

    await attachSamplePdf(row.contract_chat_id);
  } catch (err) {
    console.error('[demo] bootstrap threw', err instanceof Error ? err.message : err);
  }
}

/**
 * Upload the sample MSA into the freshly-created contract-review DM.
 *
 * Runs through the session client as the real signed-in user, who is already a
 * member of `chatId` by this point — the same authorisation path an ordinary
 * upload takes in `app/api/chats/[chatId]/files/route.ts`. Nothing here reaches
 * for elevated rights.
 */
async function attachSamplePdf(chatId: string): Promise<void> {
  const supabase = await createClient();

  const { data: auth } = await supabase.auth.getClaims();
  const actorId = auth?.claims?.sub as string | undefined;
  if (!actorId) return;

  const bytes = sampleContractPdf();
  const storagePath = `${chatId}/Meridian-MSA-draft.pdf`;

  const { error: uploadError } = await supabase.storage
    .from('chat-files')
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });

  if (uploadError) {
    console.error('[demo] sample PDF upload failed', { chatId, message: uploadError.message });
    return;
  }

  const { error: rowError } = await supabase.from('files').insert({
    chat_id: chatId,
    uploader_id: actorId,
    storage_path: storagePath,
    filename: 'Meridian-MSA-draft.pdf',
    mime_type: 'application/pdf',
    size_bytes: bytes.byteLength,
  });

  if (rowError) {
    console.error('[demo] sample PDF row insert failed', { chatId, message: rowError.message });
  }
}

/**
 * Delete and rebuild the caller's demo world. Used by `POST /api/demo/reset`.
 *
 * `reset_demo_world()` only ever touches chats where the caller is a member and
 * `is_demo = true` (migration 0020), so this cannot reach anyone else's rooms
 * or any real chat regardless of what a caller sends — it takes no id at all.
 */
export async function resetDemoWorld(): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('reset_demo_world');
  if (error) {
    console.error('[demo] reset_demo_world failed', { code: error.code, message: error.message });
    throw new Error('could not reset the demo world');
  }
  await ensureDemoWorld();
}
