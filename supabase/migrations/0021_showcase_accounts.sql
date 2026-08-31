-- 0021 — showcase accounts: two real, sign-in-able identities with a rich,
-- pre-populated world, publicly offered on the landing page.
--
-- ---------------------------------------------------------------------------
-- HOW THIS DIFFERS FROM THE DEMO WORLD (migration 0020)
--
-- The demo world (Priya/Sam) is built PER VISITOR, on their own real account,
-- so every new signup gets a small, personal demonstration. This is the
-- opposite shape: two FIXED, shared accounts — "Jordan Reyes" and "Morgan
-- Blake" — seeded ONCE with several rooms, real message history, and a memory
-- layer already populated, so a visitor can see a rich multi-room, multi-
-- clearance world in one click, with no setup of their own required.
--
-- Content is seeded by `scripts/seed-showcase-accounts.mjs`, not this
-- migration — the same reason `ensure_demo_world()`'s personas are seeded by
-- `scripts/seed-demo-personas.mjs` rather than SQL: this file only adds the
-- columns and the sign-in surface, so a schema change is never confused with
-- a data-seeding decision.
--
-- ---------------------------------------------------------------------------
-- WHY AN ANON READ POLICY, HERE SPECIFICALLY
--
-- `profiles_select_authenticated` (0002) intentionally does not cover an
-- unauthenticated visitor — the landing page has no session yet, and that is
-- exactly when it needs to show who "Jordan" and "Morgan" are, so a click can
-- carry a name and a role rather than a bare button. The alternative was a
-- server route reading with the service key, which would be a second file
-- touching `SUPABASE_SECRET_KEY` for no reason RLS cannot already handle: the
-- rows being exposed are two fixed, public, harmless profiles by design, so a
-- narrow `anon` policy scoped to exactly `is_showcase = true` is the correct
-- amount of exposure — not the two extra columns, not the rest of the table,
-- and not any real user's row.

alter table public.profiles add column is_showcase   boolean not null default false;
alter table public.profiles add column showcase_key  text unique;
alter table public.profiles add column showcase_title text;
alter table public.profiles add column showcase_note  text;

comment on column public.profiles.is_showcase is
  'A fixed, publicly sign-in-able showcase identity (e.g. "Jordan Reyes"), '
  'never a real reviewer. Implies is_demo = true (excluded from the '
  'Directory, New group, and clearance-granting lists) and additionally '
  'grants an anon read of name/title/note so the landing page can show who '
  'it is before sign-in.';

create policy profiles_select_anon_showcase
  on public.profiles for select
  to anon
  using (is_showcase = true);

-- Belt and suspenders with the application-layer filter: a showcase profile
-- must always also be a demo profile, so it can never slip into the
-- Directory/New-group/clearance lists just because someone forgot to set both
-- flags in the seed script.
alter table public.profiles add constraint showcase_implies_demo
  check (not is_showcase or is_demo);
