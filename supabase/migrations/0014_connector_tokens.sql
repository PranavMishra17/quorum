-- 0014 — external connector tokens (Google: Gmail + Calendar, read-only).
--
-- A refresh token is a bearer credential for someone's entire mailbox. It is
-- the most dangerous single value this system will ever hold, and it is held
-- accordingly.
--
-- ---------------------------------------------------------------------------
-- THE CONSTRUCTION: RLS ON, NO POLICY, GRANTS REVOKED
--
-- Exactly the memory-table construction, for the same reason. There is no
-- version of "the browser may read this row" that is acceptable, so the browser
-- cannot — at all. `authenticated` and `anon` hold no privileges here, and with
-- RLS enabled and zero policies the table is empty to everyone except
-- `service_role` (which bypasses RLS) and the SECURITY DEFINER functions below.
--
-- The publishable key is in the browser bundle. A table live for one deploy
-- without this treatment is a table of mailbox credentials that anyone can read.
--
-- ---------------------------------------------------------------------------
-- WHY THE TOKEN IS ENCRYPTED ANYWAY
--
-- Storing it in plaintext because RLS protects the row would be asking one
-- control to do two jobs. RLS defends against a query; it does nothing about a
-- database backup, a logical replica, or a support engineer with read access.
-- The ciphertext is AES-256-GCM under a key held only in the application
-- environment (`CONNECTOR_ENCRYPTION_KEY`), so a database compromise alone
-- yields no mailboxes. See lib/connectors/crypto.ts.
--
-- This is not a claim that the design is safe against an application
-- compromise. It is not, and nothing at this layer could make it so.
--
-- ---------------------------------------------------------------------------
-- SCOPE: PER USER, NEVER PER WORKSPACE
--
-- The primary key is (user_id, provider). A token is usable only by a turn
-- whose ACTOR is that user — enforced in lib/db/scoped-agent.ts, which reads
-- this table keyed on `this.actorId` and nothing else. Alice connecting her
-- mailbox does not let the agent read it on Bob's behalf, in a chat Alice is
-- not in, or in a turn Alice did not start. That is D-019 (agent authority is
-- chat-scoped) applied to an external resource.

create table public.connector_tokens (
  user_id                 uuid        not null references auth.users(id) on delete cascade,
  -- A closed set. A free-text provider would make the encrypted blob's format
  -- ambiguous and the audit trail useless.
  provider                text        not null check (provider in ('google')),
  -- AES-256-GCM, base64. NEVER the raw token.
  refresh_token_encrypted text        not null,
  -- What the user actually consented to, recorded at grant time. The tools
  -- check this rather than assuming the scopes they asked for were given —
  -- a user can untick one on Google's consent screen.
  scopes                  text[]      not null default '{}',
  connected_at            timestamptz not null default now(),
  -- Soft revocation: the row is kept so "Alice disconnected Gmail on the 3rd"
  -- remains answerable. A revoked row is never usable.
  revoked_at              timestamptz,
  primary key (user_id, provider)
);

alter table public.connector_tokens enable row level security;

-- No policy is created. That is deliberate, and it is the whole protection:
-- with RLS enabled, a table with no permissive policy returns nothing.
revoke all on table public.connector_tokens from anon, authenticated;

comment on table public.connector_tokens is
  'Encrypted OAuth refresh tokens for external connectors. No RLS policy exists '
  'by design: unreachable from the browser, readable only through '
  'lib/db/scoped-agent.ts scoped to the turn actor.';

-- ---------------------------------------------------------------------------
-- The user-facing surface: status and disconnection, never the token
-- ---------------------------------------------------------------------------

-- A user must be able to see whether they are connected and to disconnect. Both
-- need to reach a table they hold no privileges on, so both go through
-- SECURITY DEFINER functions scoped to `auth.uid()`.
--
-- The functions take NO user id. Passing one would make them an oracle for
-- whose mailbox is connected — and `auth.uid()` re-applied inside the body is
-- what keeps a SECURITY DEFINER function from becoming an unscoped read (T4).

create or replace function public.connector_status()
returns table (
  provider     text,
  scopes       text[],
  connected_at timestamptz,
  revoked_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.provider, t.scopes, t.connected_at, t.revoked_at
  from public.connector_tokens t
  where t.user_id = (select auth.uid())
$$;

revoke all on function public.connector_status() from public;
grant execute on function public.connector_status() to authenticated;

-- Storing a grant. Note the signature: it takes NO user id.
--
-- The row lands against `auth.uid()` and can land nowhere else, so even if every
-- parameter were attacker-chosen the worst outcome is a user connecting their
-- own account to a mailbox they control — which is a thing they may already do.
-- A `p_user_id` parameter would turn this into "attach my mailbox to your
-- account", and the agent would then quote it to that user as their own mail.
--
-- The token arrives ALREADY ENCRYPTED. The database never sees a plaintext
-- refresh token, so it cannot end up in a query log, a statement sample, or a
-- `pg_stat_statements` row.
create or replace function public.connect_google(
  p_refresh_token_encrypted text,
  p_scopes                  text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_refresh_token_encrypted is null or length(p_refresh_token_encrypted) = 0 then
    raise exception 'refusing to store an empty token' using errcode = '22023';
  end if;

  insert into public.connector_tokens
    (user_id, provider, refresh_token_encrypted, scopes, connected_at, revoked_at)
  values
    (v_actor, 'google', p_refresh_token_encrypted, coalesce(p_scopes, '{}'), now(), null)
  on conflict (user_id, provider) do update
    set refresh_token_encrypted = excluded.refresh_token_encrypted,
        scopes                  = excluded.scopes,
        connected_at            = now(),
        -- Reconnecting clears a previous revocation; otherwise a user who
        -- disconnects can never reconnect and the row is a tombstone.
        revoked_at              = null;
end;
$$;

revoke all on function public.connect_google(text, text[]) from public;
grant execute on function public.connect_google(text, text[]) to authenticated;

create or replace function public.disconnect_connector(p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.connector_tokens
     set revoked_at = now()
   where user_id = v_actor
     and provider = p_provider
     and revoked_at is null;
end;
$$;

revoke all on function public.disconnect_connector(text) from public;
grant execute on function public.disconnect_connector(text) to authenticated;

-- Note what is NOT here: no function that returns the token. The only reader is
-- the service-role client inside lib/db/scoped-agent.ts, and it is keyed on the
-- turn's actor. Exposing a "get my token" RPC to `authenticated` would put a
-- mailbox credential one XSS away from an attacker.
