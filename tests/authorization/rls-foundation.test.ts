import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { asUser, asAnon, asSuper } from '../db/harness';
import { truncateAll } from '../db/fixtures';

/**
 * Foundation tests for migrations 0001–0002.
 *
 * Everything else in the authorization suite assumes these hold. If
 * `auth.uid()` does not round-trip, every policy in the project is silently
 * evaluating against NULL and every "denied" result is denied for the wrong
 * reason — which would look exactly like a passing test suite.
 */

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

let admin: Client;

beforeAll(async () => {
  admin = await asSuper();
  // Suites share one database and run serially. Each starts from a clean world
  // so a count assertion here cannot be broken by another file's fixtures.
  await truncateAll(admin);
  await admin.query(
    `insert into auth.users (id, email) values ($1,'alice@test'), ($2,'bob@test')
     on conflict (id) do nothing`,
    [ALICE, BOB],
  );
  await admin.query(
    `insert into public.profiles (id, display_name) values ($1,'Alice'), ($2,'Bob')
     on conflict (id) do nothing`,
    [ALICE, BOB],
  );
  await admin.query(
    `insert into public.clearances (key, name, level) values
       ('general','General',0), ('internal','Internal',1),
       ('confidential','Confidential',2), ('restricted','Restricted',3)
     on conflict (key) do nothing`,
  );
});

afterAll(async () => {
  await admin?.end();
});

/**
 * THE ASSERTION EVERYTHING ELSE RESTS ON.
 *
 * Research R1 could not source, from primary documentation, whether
 * `auth.uid()` survives a `SECURITY DEFINER` role switch — and the entire
 * membership predicate design depends on it. It is cheap to settle, so it is
 * settled here, first, before anything is built on top of it.
 */
describe('auth.uid() round-trip', () => {
  it('resolves the JWT subject claim for a signed-in role', async () => {
    const client = await asUser(ALICE);
    try {
      const res = await client.query('select auth.uid() as uid');
      expect(res.rows[0].uid).toBe(ALICE);
    } finally {
      await client.end();
    }
  });

  it('is NULL when signed out', async () => {
    const client = await asAnon();
    try {
      const res = await client.query('select auth.uid() as uid');
      expect(res.rows[0].uid).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('survives a SECURITY DEFINER call — the unverified assumption', async () => {
    // A SECURITY DEFINER function switches the role used for privilege checks.
    // GUCs are session-scoped and are NOT reset by that switch, so auth.uid()
    // must still resolve inside the function body. If this ever fails, every
    // membership predicate in the project is evaluating against NULL.
    await admin.query(`
      create or replace function private.uid_probe()
      returns uuid language sql stable security definer set search_path = ''
      as $$ select auth.uid() $$;
      grant execute on function private.uid_probe() to authenticated;
      grant usage on schema private to authenticated;
    `);
    const client = await asUser(BOB);
    try {
      const res = await client.query('select private.uid_probe() as uid');
      expect(res.rows[0].uid).toBe(BOB);
    } finally {
      await client.end();
      await admin.query('revoke usage on schema private from authenticated');
    }
  });
});

describe('the harness itself is honest', () => {
  it('runs as `authenticated`, not as a superuser', async () => {
    const client = await asUser(ALICE);
    try {
      const res = await client.query(
        'select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass',
      );
      expect(res.rows[0].u).toBe('authenticated');
      // If this role could bypass RLS, every policy test below would be theatre.
      expect(res.rows[0].bypass).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('grants table privileges, so denial comes from RLS and not from a missing GRANT', async () => {
    const client = await asUser(ALICE);
    try {
      const res = await client.query(
        `select has_table_privilege('authenticated','public.profiles','select') as g`,
      );
      expect(res.rows[0].g).toBe(true);
    } finally {
      await client.end();
    }
  });
});

describe('profiles', () => {
  it('are readable by any signed-in user', async () => {
    const client = await asUser(ALICE);
    try {
      const res = await client.query('select count(*)::int as n from public.profiles');
      expect(res.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  it('are NOT readable when signed out', async () => {
    const client = await asAnon();
    try {
      const res = await client.query('select count(*)::int as n from public.profiles');
      expect(res.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('cannot be edited by another user', async () => {
    const client = await asUser(BOB);
    try {
      const res = await client.query(
        `update public.profiles set display_name = 'Hacked' where id = $1 returning id`,
        [ALICE],
      );
      expect(res.rowCount).toBe(0);
    } finally {
      await client.end();
    }
    const check = await admin.query('select display_name from public.profiles where id = $1', [ALICE]);
    expect(check.rows[0].display_name).toBe('Alice');
  });

  it('can be edited by their owner', async () => {
    const client = await asUser(BOB);
    try {
      const res = await client.query(
        `update public.profiles set display_name = 'Bobby' where id = $1 returning display_name`,
        [BOB],
      );
      expect(res.rows[0].display_name).toBe('Bobby');
    } finally {
      await client.end();
    }
  });

  it('cannot be created on behalf of someone else', async () => {
    const client = await asUser(BOB);
    const orphan = '33333333-3333-3333-3333-333333333333';
    await admin.query(`insert into auth.users (id, email) values ($1,'c@test') on conflict do nothing`, [orphan]);
    try {
      await expect(
        client.query(`insert into public.profiles (id, display_name) values ($1, 'Carol')`, [orphan]),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await client.end();
    }
  });
});

describe('clearances', () => {
  it('the ladder is readable by signed-in users', async () => {
    const client = await asUser(ALICE);
    try {
      const res = await client.query('select count(*)::int as n from public.clearances');
      expect(res.rows[0].n).toBe(4);
    } finally {
      await client.end();
    }
  });

  it('cannot be granted to yourself — the second axis would be worthless', async () => {
    const client = await asUser(ALICE);
    try {
      const cid = (await admin.query(`select id from public.clearances where key='restricted'`)).rows[0].id;
      await expect(
        client.query(`insert into public.user_clearances (user_id, clearance_id) values ($1,$2)`, [ALICE, cid]),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await client.end();
    }
  });

  it('the ladder itself cannot be edited by a client', async () => {
    const client = await asUser(ALICE);
    try {
      const res = await client.query(`update public.clearances set level = 99 where key = 'general' returning key`);
      expect(res.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
