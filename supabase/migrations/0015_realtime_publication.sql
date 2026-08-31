-- 0015 — put the live-updating tables into Supabase's Realtime publication.
--
-- ---------------------------------------------------------------------------
-- WHY THIS WAS MISSING, AND WHAT IT COST
--
-- Supabase Realtime only emits `postgres_changes` for tables that are members
-- of the `supabase_realtime` publication. Nothing in migrations 0001–0014 ever
-- added one, and `docs/SETUP-SUPABASE.md` never told anyone to tick the boxes in
-- Database / Replication either. So the entire live-update path — new messages,
-- the agent's reply, the internal view's event stream — depended on a
-- subscription that was never actually fed.
--
-- The symptom was reported as "I open a chat, send a message, and cannot see
-- it — but I can see it in a floating panel". That is exactly this bug wearing
-- a disguise: the panel mounts and does a fresh client-side fetch, so it shows
-- rows the already-mounted page was still waiting for an event about.
--
-- Worth being blunt about the process failure: `channel.subscribe()` reports
-- SUBSCRIBED whether or not the table is published, so nothing errors and
-- nothing logs. A missing publication is indistinguishable from a quiet chat.
-- This is the same shape as T12 in CLAUDE.md — a silent skip that looks like a
-- pass — and it survived a "verified in a real browser" claim, which is a
-- reminder that watching for a thing to APPEAR is a weaker test than watching
-- for it to appear WITHOUT a reload.
--
-- ---------------------------------------------------------------------------
-- THIS IS NOT AN AUTHORISATION CHANGE
--
-- Realtime authorises every message it delivers against RLS as the subscribing
-- user, so publishing a table does not widen who can read it. A non-member's
-- subscription is accepted and then delivers nothing, which is the same answer
-- their SELECT gets.
--
-- The known limitation is unchanged and is still T11: Realtime evaluates RLS
-- when the socket is established and caches that decision for the socket's
-- lifetime, so a removed member with an open subscription keeps receiving until
-- they reconnect. `lib/agent`'s revocation broadcast narrows that window
-- cooperatively; it does not close it.

-- The publication exists on hosted Supabase but not in the local test harness,
-- where these migrations also run. Create it only if absent.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- Idempotent per table: `alter publication ... add table` errors if the table is
-- already a member, and on a project where the boxes were ticked by hand some
-- of these may already be in.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['messages', 'agent_events'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;

-- Deliberately NOT published:
--
--   memory_items / memory_audience — no client may read them at all (RLS on,
--     zero policies). Publishing them would be harmless in practice but would
--     contradict the construction, and a future reader would wonder why.
--   connector_tokens — same, and it holds mailbox credentials.
--   llm_calls — the cost/token rows. The UI seeds them once per page load and
--     says so; a live cost ticker is not worth a second subscription per chat.
--   chat_members — a membership change should be felt as a refused READ (D-012),
--     not as a pushed event. Publishing it would invite a UI that trusts a
--     socket to tell it about revocation, which is precisely the cooperative
--     control T11 warns against relying on.
