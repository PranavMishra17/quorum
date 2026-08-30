-- 0013 — the storage bucket and its policies.
--
-- Migration 0007 described these in a comment. A described policy is not an
-- applied one, and the gap between the two is exactly where a "private" bucket
-- turns out to be readable.
--
-- The whole file is guarded on `storage.objects` existing, because the test
-- harness runs a bare PostgreSQL with no Supabase storage schema. Guarding is
-- better than splitting this into a Supabase-only file: the migration set stays
-- one thing that runs everywhere, and the policies live next to the table they
-- protect rather than in a dashboard nobody diffs.

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage schema absent (local Postgres) — skipping bucket policies';
    return;
  end if;

  -- Private. A public bucket makes every object readable by URL to anyone with
  -- the path, which defeats the entire authorisation model in one setting.
  insert into storage.buckets (id, name, public)
  values ('chat-files', 'chat-files', false)
  on conflict (id) do update set public = false;

  -- Same predicate as public.files, deliberately. The bytes and the metadata
  -- must not be able to drift apart in what they permit — if the table said one
  -- thing and the bucket another, the looser of the two would be the real rule.
  --
  -- The chat id is the first path segment, which is why 0007 constrains
  -- storage_path with a CHECK: a row whose path did not start with its chat id
  -- would be authorised by the table and mis-authorised here.
  execute $ddl$
    drop policy if exists "chat files are readable by chat members" on storage.objects;
    create policy "chat files are readable by chat members"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'chat-files'
        and private.can_access_chat(
          ((storage.foldername(name))[1])::uuid,
          (select auth.uid())
        )
      );

    drop policy if exists "chat files are writable by chat members" on storage.objects;
    create policy "chat files are writable by chat members"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'chat-files'
        and private.can_access_chat(
          ((storage.foldername(name))[1])::uuid,
          (select auth.uid())
        )
      );

    -- Deletion goes through the owner check on public.files; an object with no
    -- delete policy cannot be removed by a client directly, which keeps the two
    -- in step.
    drop policy if exists "chat files are deletable by uploader" on storage.objects;
    create policy "chat files are deletable by uploader"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'chat-files'
        and exists (
          select 1 from public.files f
          where f.storage_path = storage.objects.name
            and f.uploader_id = (select auth.uid())
        )
      );
  $ddl$;

  -- Note what is deliberately NOT here: a grant of `private` to authenticated.
  --
  -- RLS policy expressions are evaluated with the privileges of the table's
  -- owner, not the invoking role, so the policies above can call
  -- private.can_access_chat() while a client still cannot. The table policies in
  -- 0003 already rely on this, and tests/authorization/membership.test.ts pins
  -- it: a client calling private.is_chat_member() is refused.
end
$$;
