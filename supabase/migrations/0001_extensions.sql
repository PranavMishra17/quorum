-- 0001 — extensions and the private helper schema.
--
-- No `vector` extension: D-004 closed against wiring an embedding provider in
-- v1. Memory ranking is lexical (`ts_rank`) over an already-authorised
-- candidate set. Adding it later is an additive migration.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- private: the home of SECURITY DEFINER authorisation predicates.
--
-- These functions are called from RLS policies. They live in their own schema
-- and are NOT granted to `anon` or `authenticated`, so a client cannot call
-- them directly to probe authorisation — only the policy engine invokes them.
-- ---------------------------------------------------------------------------

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to postgres;
