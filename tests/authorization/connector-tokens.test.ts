import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asAnon, asSuper } from '../db/harness';
import { seedUsers, truncateAll, type UserMap } from '../db/fixtures';

/**
 * `connector_tokens` — migration 0014.
 *
 * This table holds encrypted OAuth refresh tokens: bearer credentials for
 * people's entire mailboxes, and the most dangerous values in the system. The
 * claim being tested is stronger than the usual one. It is not "a user may read
 * only their own row" — it is **no browser client may read any row at all**,
 * including their own.
 *
 * That is why the table has RLS enabled and ZERO policies. There is no version
 * of "the client may read this" that is acceptable, so the client cannot. The
 * only paths in are two SECURITY DEFINER functions that scope themselves to
 * `auth.uid()` and never return the token column, plus the service-role client
 * in lib/db/scoped-agent.ts.
 *
 * Every assertion runs as an unprivileged role. `admin` is fixtures only —
 * it bypasses RLS, so an assertion through it would prove nothing.
 */

let admin: Client;
let u: UserMap;

beforeAll(async () => { admin = await asSuper(); });
afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  u = await seedUsers(admin, ['Alice', 'Bob']);
});

async function callAs<T = Record<string, unknown>>(
  actor: string,
  sql: string,
  args: unknown[] = [],
): Promise<T[]> {
  const c = await asUser(actor);
  try {
    return (await c.query(sql, args)).rows as T[];
  } finally {
    await c.end();
  }
}

const storedFor = async (userId: string) =>
  (await admin.query(
    'select refresh_token_encrypted, scopes, revoked_at from public.connector_tokens where user_id=$1',
    [userId],
  )).rows as { refresh_token_encrypted: string; scopes: string[]; revoked_at: string | null }[];

// ---------------------------------------------------------------------------

describe('the table is unreachable from the browser', () => {
  it('a signed-in user cannot select from it — not even their own row', async () => {
    await callAs(u.Alice, `select public.connect_google($1, $2)`, ['sealed-alice', ['gmail.readonly']]);
    // The row exists...
    expect(await storedFor(u.Alice)).toHaveLength(1);
    // ...and Alice still cannot read it.
    await expect(callAs(u.Alice, 'select * from public.connector_tokens')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('an anonymous client cannot select from it', async () => {
    const c = await asAnon();
    try {
      await expect(c.query('select * from public.connector_tokens')).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await c.end();
    }
  });

  it('a signed-in user cannot insert a row directly', async () => {
    await expect(
      callAs(u.Alice, `insert into public.connector_tokens
        (user_id, provider, refresh_token_encrypted) values ($1,'google','forged')`, [u.Alice]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('and cannot update or delete one', async () => {
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['sealed', ['gmail.readonly']]);
    await expect(
      callAs(u.Alice, `update public.connector_tokens set refresh_token_encrypted='swapped'`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      callAs(u.Alice, 'delete from public.connector_tokens'),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('connect_google() attaches a mailbox to the CALLER and to nobody else', () => {
  it('stores the grant against auth.uid()', async () => {
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['sealed-alice', ['gmail.readonly']]);

    const rows = await storedFor(u.Alice);
    expect(rows).toHaveLength(1);
    expect(rows[0].refresh_token_encrypted).toBe('sealed-alice');
    expect(rows[0].scopes).toEqual(['gmail.readonly']);
    expect(await storedFor(u.Bob)).toHaveLength(0);
  });

  /**
   * The signature is the control. There is no p_user_id, so there is no
   * argument any caller could supply that attaches THEIR mailbox to SOMEONE
   * ELSE's account — after which the agent would quote it to that person as
   * their own mail and act on whatever it said.
   */
  it('takes no user id at all, so it cannot be pointed at another account', async () => {
    const args = await admin.query(
      `select p.parameter_name
         from information_schema.parameters p
         join information_schema.routines r
           on r.specific_name = p.specific_name
        where r.routine_name = 'connect_google'
          and r.routine_schema = 'public'`,
    );
    const names = args.rows.map((r) => (r.parameter_name as string).toLowerCase());
    expect(names).toEqual(['p_refresh_token_encrypted', 'p_scopes']);
    expect(names.join(',')).not.toMatch(/user/);
  });

  it('the database never sees a plaintext token — it stores what it is handed', async () => {
    // Encryption happens in the application (lib/connectors/crypto.ts), so a
    // plaintext refresh token cannot appear in a query log or a statement
    // sample. This asserts the contract: whatever arrives is stored verbatim.
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['AAAA-ciphertext', []]);
    expect((await storedFor(u.Alice))[0].refresh_token_encrypted).toBe('AAAA-ciphertext');
  });

  it('refuses an empty token rather than storing a useless row', async () => {
    await expect(
      callAs(u.Alice, 'select public.connect_google($1,$2)', ['', []]),
    ).rejects.toThrow(/empty token/i);
  });

  it('reconnecting replaces the token and clears a previous revocation', async () => {
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['first', ['gmail.readonly']]);
    await callAs(u.Alice, `select public.disconnect_connector('google')`);
    expect((await storedFor(u.Alice))[0].revoked_at).not.toBeNull();

    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['second', ['gmail.readonly']]);
    const rows = await storedFor(u.Alice);
    expect(rows).toHaveLength(1);
    expect(rows[0].refresh_token_encrypted).toBe('second');
    // Without this, disconnecting once would make the connector permanently
    // unreachable and the row a tombstone.
    expect(rows[0].revoked_at).toBeNull();
  });

  it('records the scopes Google actually granted, which may be fewer than asked', async () => {
    // A user can untick a scope on the consent screen. Recording what we asked
    // for instead of what we got turns a deliberate refusal into an opaque
    // API error later.
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['sealed', ['gmail.readonly']]);
    expect((await storedFor(u.Alice))[0].scopes).toEqual(['gmail.readonly']);
  });
});

describe('connector_status() shows the caller their own connection, without the token', () => {
  beforeEach(async () => {
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['sealed-alice', ['gmail.readonly']]);
    await callAs(u.Bob, 'select public.connect_google($1,$2)', ['sealed-bob', ['calendar.readonly']]);
  });

  it('returns the caller\'s row', async () => {
    const rows = await callAs<{ provider: string; scopes: string[] }>(
      u.Alice, 'select * from public.connector_status()',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('google');
    expect(rows[0].scopes).toEqual(['gmail.readonly']);
  });

  it('NEVER returns the token, not even the caller\'s own', async () => {
    // A "get my token" RPC granted to `authenticated` would put a mailbox
    // credential one XSS away from an attacker.
    const rows = await callAs<Record<string, unknown>>(
      u.Alice, 'select * from public.connector_status()',
    );
    expect(Object.keys(rows[0])).toEqual(['provider', 'scopes', 'connected_at', 'revoked_at']);
    expect(JSON.stringify(rows[0])).not.toContain('sealed');
  });

  it('does not show Bob\'s connection to Alice', async () => {
    const rows = await callAs<{ scopes: string[] }>(u.Alice, 'select * from public.connector_status()');
    expect(rows).toHaveLength(1);
    expect(rows[0].scopes).not.toContain('calendar.readonly');
  });

  it('shows nothing to a user who has connected nothing', async () => {
    const u2 = await seedUsers(admin, ['Carol']);
    expect(await callAs(u2.Carol, 'select * from public.connector_status()')).toHaveLength(0);
  });

  it('is unreachable anonymously', async () => {
    const c = await asAnon();
    try {
      // Either the grant is refused or it returns nothing — both are correct;
      // what must never happen is another user's row coming back.
      const result = await c.query('select * from public.connector_status()').catch(() => null);
      expect(result?.rows ?? []).toHaveLength(0);
    } finally {
      await c.end();
    }
  });
});

describe('disconnect_connector() revokes the caller\'s own connection only', () => {
  beforeEach(async () => {
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['sealed-alice', []]);
    await callAs(u.Bob, 'select public.connect_google($1,$2)', ['sealed-bob', []]);
  });

  it('revokes the caller\'s row', async () => {
    await callAs(u.Alice, `select public.disconnect_connector('google')`);
    expect((await storedFor(u.Alice))[0].revoked_at).not.toBeNull();
  });

  it('CANNOT revoke anybody else — the function takes no user id', async () => {
    await callAs(u.Alice, `select public.disconnect_connector('google')`);
    expect((await storedFor(u.Bob))[0].revoked_at).toBeNull();
  });

  it('keeps the row, so "when did Alice disconnect?" stays answerable', async () => {
    await callAs(u.Alice, `select public.disconnect_connector('google')`);
    expect(await storedFor(u.Alice)).toHaveLength(1);
  });

  it('is idempotent — disconnecting twice does not error or move the timestamp', async () => {
    await callAs(u.Alice, `select public.disconnect_connector('google')`);
    const first = (await storedFor(u.Alice))[0].revoked_at;
    await callAs(u.Alice, `select public.disconnect_connector('google')`);
    expect((await storedFor(u.Alice))[0].revoked_at).toEqual(first);
  });
});

describe('the schema itself', () => {
  it('has row-level security enabled', async () => {
    const { rows } = await admin.query(
      `select relrowsecurity from pg_class
        where oid = 'public.connector_tokens'::regclass`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it('has NO policies — that absence is the protection, not an oversight', async () => {
    const { rows } = await admin.query(
      `select policyname from pg_policies
        where schemaname='public' and tablename='connector_tokens'`,
    );
    expect(rows).toEqual([]);
  });

  it('refuses an unknown provider, so the ciphertext format stays unambiguous', async () => {
    await expect(
      admin.query(`insert into public.connector_tokens
        (user_id, provider, refresh_token_encrypted) values ($1,'dropbox','x')`, [u.Alice]),
    ).rejects.toThrow(/check constraint/i);
  });

  it('removes the token when the user is deleted', async () => {
    await callAs(u.Alice, 'select public.connect_google($1,$2)', ['sealed', []]);
    await admin.query('delete from auth.users where id=$1', [u.Alice]);
    expect(await storedFor(u.Alice)).toHaveLength(0);
  });
});
