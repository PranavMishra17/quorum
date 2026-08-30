-- 0007 — file metadata.
--
-- The row here is the authorisation record; the bytes live in Supabase Storage.
-- Both are gated on the same predicate, so a file uploaded in chat A is not
-- readable from chat B — asserted in tests/tools/scoping.test.ts.

create table public.files (
  id           uuid primary key default gen_random_uuid(),
  chat_id      uuid not null references public.chats(id) on delete cascade,
  uploader_id  uuid not null references auth.users(id) on delete restrict,
  -- Path within the bucket. The chat id is the FIRST path segment, which is
  -- what lets the storage policy reuse can_access_chat() without a table
  -- lookup — see the storage policy note at the bottom of this file.
  storage_path text not null unique,
  filename     text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  created_at   timestamptz not null default now(),

  constraint storage_path_is_chat_scoped
    check (storage_path like (chat_id::text || '/%'))
);

create index files_chat_idx on public.files (chat_id, created_at desc);

alter table public.files enable row level security;

create policy files_select
  on public.files for select
  to authenticated
  using (private.can_access_chat(chat_id, (select auth.uid())));

create policy files_insert
  on public.files for insert
  to authenticated
  with check (
    uploader_id = (select auth.uid())
    and private.can_access_chat(chat_id, (select auth.uid()))
  );

-- Uploaders may withdraw their own file; nobody may rewrite the record.
create policy files_delete_own
  on public.files for delete
  to authenticated
  using (
    uploader_id = (select auth.uid())
    and private.can_access_chat(chat_id, (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Storage bucket policy (applied against a real Supabase project, where the
-- `storage.objects` table exists; there is no local equivalent to run it
-- against, which is why it is documented here rather than executed).
--
--   create policy "chat files are chat-scoped"
--     on storage.objects for select to authenticated
--     using (
--       bucket_id = 'chat-files'
--       and private.can_access_chat(
--             (storage.foldername(name))[1]::uuid, (select auth.uid()))
--     );
--
-- Same predicate as the table above, which is the point: the bytes and the
-- metadata cannot drift apart in what they permit. The bucket must be PRIVATE —
-- a public bucket makes every object readable by URL and defeats all of this.
-- ---------------------------------------------------------------------------
