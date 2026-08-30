import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * The authorization test harness.
 *
 * Everything here exists to serve one rule: **RLS is tested as an unprivileged
 * role, never through a client that bypasses it.** A suite that verifies
 * policies using the service role would pass against a completely unprotected
 * database, which is the most expensive kind of green tick there is.
 *
 * So there are exactly three ways to get a connection, and only one of them is
 * allowed to make assertions:
 *
 *   asUser(id)  — role `authenticated`, JWT claims set. ASSERT WITH THIS.
 *   asAnon()    — role `anon`, signed out. ASSERT WITH THIS.
 *   asSuper()   — superuser. FIXTURE SETUP ONLY. Never assert with it.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const SHIM = join(process.cwd(), 'tests', 'db', 'auth-shim.sql');

export function connectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The database harness starts in ' +
        'tests/db/global-setup.ts — did the global setup fail?',
    );
  }
  return url;
}

/** Ordered migration files. Numeric prefix defines the order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Drop everything and re-apply the shim plus every migration, in order.
 *
 * Applied fresh on every run rather than incrementally: a migration that only
 * works against a database carrying leftover state from a previous run is a
 * migration that will fail on a real deploy.
 */
export async function resetDatabase(): Promise<void> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await client.query(`
      drop schema if exists public  cascade;
      drop schema if exists private cascade;
      drop schema if exists auth    cascade;
      create schema public;
    `);

    await client.query(readFileSync(SHIM, 'utf8'));

    for (const file of migrationFiles()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query(sql);
      } catch (err) {
        // Name the migration. "syntax error at or near" with no file is a
        // miserable thing to debug across eight files.
        throw new Error(
          `Migration ${file} failed: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * A connection acting as a signed-in user.
 *
 * `SET ROLE authenticated` plus `request.jwt.claims` is exactly how PostgREST
 * presents a request to Postgres, which is why `auth.uid()` resolves correctly
 * inside policies without any test-specific special-casing.
 */
export async function asUser(userId: string): Promise<Client> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  await client.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await client.query('set role authenticated');
  return client;
}

/** A signed-out connection. */
export async function asAnon(): Promise<Client> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  await client.query(`select set_config('request.jwt.claims', '', false)`);
  await client.query('set role anon');
  return client;
}

/**
 * Superuser. **Fixture setup only.**
 *
 * Bypasses RLS entirely, so an assertion made through this connection proves
 * nothing about authorisation. If you find yourself reaching for it inside an
 * `expect`, the test is wrong.
 */
export async function asSuper(): Promise<Client> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  return client;
}

/** Run a callback with a client, closing it even if the callback throws. */
export async function withClient<T>(
  factory: () => Promise<Client>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await factory();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Assert that a query is refused, without caring HOW it is refused.
 *
 * RLS denial and privilege denial look different — one returns zero rows, the
 * other raises. Both are "you may not have this", and a test that only accepts
 * one of them is brittle for no benefit.
 */
export async function selectCount(
  client: Client,
  table: string,
  where = 'true',
): Promise<number> {
  try {
    const res = await client.query(`select count(*)::int as n from ${table} where ${where}`);
    return res.rows[0].n as number;
  } catch {
    return 0; // no privilege at all — denied just as firmly
  }
}
