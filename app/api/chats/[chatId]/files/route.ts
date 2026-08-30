import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';
import { safeName } from '@/lib/files/safe-name';
import { DOCX_MIME, PDF_MIME, isExtractable } from '@/lib/files/extract-text';

/**
 * File upload.
 *
 * Both writes — the object and the metadata row — go through the SESSION-BOUND
 * client, so the bucket policy and the table policy each independently refuse a
 * caller who is not a cleared member. Using the service role here would work and
 * would quietly remove both checks.
 *
 * The two must not drift: the object path begins with the chat id, which is what
 * the bucket policy reads, and `public.files` has a CHECK enforcing that the
 * stored path starts with the row's own chat id. A row whose path pointed at
 * another chat would be authorised by the table and mis-authorised by the
 * bucket.
 */

const MAX_BYTES = 5_000_000;

/**
 * What may be uploaded.
 *
 * An allowlist rather than a blocklist, and deliberately narrow: these are the
 * types `file_read` can actually extract text from. Accepting a PDF we cannot
 * parse would produce a file the agent can see listed and never read, which is
 * a worse experience than refusing it.
 */
const ALLOWED = new Map<string, string>([
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['text/csv', 'csv'],
  ['text/html', 'html'],
  ['application/json', 'json'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml'],
  [PDF_MIME, 'pdf'],
  [DOCX_MIME, 'docx'],
]);

/**
 * The allowlist and the extractor must agree.
 *
 * Accepting a type `file_read` cannot parse produces a file the agent can see
 * listed and never read — worse than refusing the upload, because it looks like
 * a capability. Asserted at module load rather than in a test, so the two
 * cannot drift apart in a deploy that never runs the suite.
 */
for (const mime of ALLOWED.keys()) {
  if (!isExtractable(mime)) {
    throw new Error(`upload allowlist admits ${mime}, which no extractor handles`);
  }
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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart form data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file supplied' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'the file is empty' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `files must be under ${Math.floor(MAX_BYTES / 1_000_000)} MB` },
      { status: 413 },
    );
  }

  // The browser-supplied type is a hint, not a fact — but combined with the
  // extension allowlist and the fact that content is never executed, only read
  // as text, it is sufficient here.
  const mime = (file.type || 'application/octet-stream').split(';')[0].trim();
  if (!ALLOWED.has(mime)) {
    return NextResponse.json(
      {
        error: `${mime} cannot be read as text. Supported: ${[...new Set(ALLOWED.keys())].join(', ')}`,
      },
      { status: 415 },
    );
  }

  const filename = safeName(file.name);
  // The chat id first: the bucket policy derives authorisation from it, and a
  // random component so two uploads of the same name cannot collide or
  // overwrite one another.
  const storagePath = `${chatId}/${randomUUID()}-${filename}`;

  const supabase = await createClient();

  const { error: uploadError } = await supabase.storage
    .from('chat-files')
    .upload(storagePath, file, { contentType: mime, upsert: false });

  if (uploadError) {
    // The bucket policy refuses a non-member here, before any row is written.
    return NextResponse.json({ error: 'not permitted to upload to this chat' }, { status: 403 });
  }

  const { data, error } = await supabase
    .from('files')
    .insert({
      chat_id: chatId,
      uploader_id: actorId,
      storage_path: storagePath,
      filename,
      mime_type: mime,
      size_bytes: file.size,
    })
    .select('id, filename')
    .single();

  if (error) {
    // The object landed but the row did not — leaving an orphan the agent can
    // never see (it lists from `files`, not from the bucket). Remove it rather
    // than leaving bytes nobody accounted for.
    await supabase.storage.from('chat-files').remove([storagePath]);
    const denied = error.code === '42501' || /row-level security/i.test(error.message);
    return NextResponse.json(
      { error: denied ? 'not permitted to upload to this chat' : 'could not record the file' },
      { status: denied ? 403 : 500 },
    );
  }

  const row = data as unknown as { id: string; filename: string };
  return NextResponse.json(
    { fileId: row.id, filename: row.filename },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
