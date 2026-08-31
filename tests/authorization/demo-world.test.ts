import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asAnon, asSuper } from '../db/harness';
import { seedUsers, truncateAll, type UserMap } from '../db/fixtures';

/**
 * `ensure_demo_world()` / `reset_demo_world()` — migration 0020.
 *
 * The design this suite is defending: exactly TWO rooms per user, seeded with
 * exactly ONE message total, and nothing else in this system can ever post a
 * message on another user's behalf outside that single moment. See the
 * migration's own header for why a broader "reply as anyone" RPC was rejected.
 *
 * These tests seed the two demo personas directly via SQL (not through
 * `scripts/seed-demo-personas.mjs`, which uses the Admin API and has no place
 * in a suite that runs against the bare test harness) — a plain `auth.users`
 * row with the well-known email is all `ensure_demo_world()` looks for.
 */

let admin: Client;
let u: UserMap;

async function seedPersonas() {
  const priya = (
    await admin.query(`insert into auth.users (email) values ('priya.demo@quorum.dev') returning id`)
  ).rows[0].id as string;
  const sam = (
    await admin.query(`insert into auth.users (email) values ('sam.demo@quorum.dev') returning id`)
  ).rows[0].id as string;
  await admin.query(
    `insert into public.profiles (id, display_name, color, is_demo) values
       ($1, 'Priya (demo)', '#61afef', true),
       ($2, 'Sam (demo)',   '#98c379', true)`,
    [priya, sam],
  );
  return { priya, sam };
}

beforeAll(async () => { admin = await asSuper(); });
afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  u = await seedUsers(admin, ['Alice']);
});

async function callAs<T = Record<string, unknown>>(userId: string, sql: string): Promise<T[]> {
  const c = await asUser(userId);
  try {
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.end();
  }
}

describe('when the personas are not seeded on this environment', () => {
  it('creates nothing and reports created=false, rather than erroring', async () => {
    const rows = await callAs(u.Alice, 'select * from public.ensure_demo_world()');
    expect(rows).toEqual([{ created: false, contract_chat_id: null, group_chat_id: null }]);
  });

  it('a sign-in still works — no demo world must never mean no sign-in', async () => {
    // The strongest way to state "graceful degradation": confirm the function
    // did not raise, by confirming the caller still has zero chats afterward
    // rather than being left in some half-created state.
    await callAs(u.Alice, 'select * from public.ensure_demo_world()');
    const chats = await callAs(u.Alice, `select * from public.chats`);
    expect(chats).toHaveLength(0);
  });
});

describe('once personas exist', () => {
  let priya: string;
  let sam: string;

  beforeEach(async () => {
    ({ priya, sam } = await seedPersonas());
  });

  it('creates exactly two chats, both marked is_demo', async () => {
    const rows = await callAs<{ created: boolean; contract_chat_id: string; group_chat_id: string }>(
      u.Alice, 'select * from public.ensure_demo_world()',
    );
    expect(rows[0].created).toBe(true);
    expect(rows[0].contract_chat_id).toBeTruthy();
    expect(rows[0].group_chat_id).toBeTruthy();

    const { rows: chats } = await admin.query(
      `select id, type, is_demo, demo_kind from public.chats where id = any($1)`,
      [[rows[0].contract_chat_id, rows[0].group_chat_id]],
    );
    expect(chats).toHaveLength(2);
    expect(chats.every((c) => c.is_demo === true)).toBe(true);
    expect(chats.find((c) => c.type === 'dm')?.demo_kind).toBe('contract');
    expect(chats.find((c) => c.type === 'group')?.demo_kind).toBe('isolation');
  });

  it('the contract DM has exactly Alice and Priya, the group has all three', async () => {
    const rows = await callAs<{ contract_chat_id: string; group_chat_id: string }>(
      u.Alice, 'select * from public.ensure_demo_world()',
    );

    const dmMembers = (
      await admin.query(`select user_id from public.chat_members where chat_id = $1`, [rows[0].contract_chat_id])
    ).rows.map((r) => r.user_id).sort();
    expect(dmMembers).toEqual([u.Alice, priya].sort());

    const groupMembers = (
      await admin.query(`select user_id from public.chat_members where chat_id = $1`, [rows[0].group_chat_id])
    ).rows.map((r) => r.user_id).sort();
    expect(groupMembers).toEqual([u.Alice, priya, sam].sort());
  });

  it('THE ISOLATION ROOM HAS NO SEED MESSAGE — its only job is who is in it', async () => {
    const rows = await callAs<{ group_chat_id: string }>(u.Alice, 'select * from public.ensure_demo_world()');
    const { rows: msgs } = await admin.query(
      `select * from public.messages where chat_id = $1`, [rows[0].group_chat_id],
    );
    expect(msgs).toHaveLength(0);
  });

  it('the contract room has exactly one seed message, from Priya', async () => {
    const rows = await callAs<{ contract_chat_id: string }>(u.Alice, 'select * from public.ensure_demo_world()');
    const { rows: msgs } = await admin.query(
      `select sender_id, sender_type from public.messages where chat_id = $1`, [rows[0].contract_chat_id],
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender_id).toBe(priya);
    expect(msgs[0].sender_type).toBe('user');
  });

  it('the seed message is backdated, not created "now"', async () => {
    const rows = await callAs<{ contract_chat_id: string }>(u.Alice, 'select * from public.ensure_demo_world()');
    const { rows: msgs } = await admin.query(
      `select created_at from public.messages where chat_id = $1`, [rows[0].contract_chat_id],
    );
    const ageMs = Date.now() - new Date(msgs[0].created_at).getTime();
    expect(ageMs).toBeGreaterThan(60 * 60 * 1000); // more than an hour old
  });

  it('IS IDEMPOTENT — a second call creates nothing more', async () => {
    await callAs(u.Alice, 'select * from public.ensure_demo_world()');
    const second = await callAs(u.Alice, 'select * from public.ensure_demo_world()');
    expect(second).toEqual([{ created: false, contract_chat_id: null, group_chat_id: null }]);

    const { rows: chats } = await admin.query(
      `select count(*)::int n from public.chats c
         join public.chat_members m on m.chat_id = c.id
       where c.is_demo = true and m.user_id = $1`,
      [u.Alice],
    );
    expect(chats[0].n).toBe(2); // still exactly two, not four
  });

  it('is unreachable anonymously', async () => {
    const c = await asAnon();
    try {
      await expect(c.query('select * from public.ensure_demo_world()')).rejects.toThrow();
    } finally {
      await c.end();
    }
  });

  it('takes no parameter — the demo world it builds is always the caller\'s own', async () => {
    const { rows } = await admin.query(
      `select count(*)::int n from information_schema.parameters p
         join information_schema.routines r on r.specific_name = p.specific_name
        where r.routine_name = 'ensure_demo_world' and r.routine_schema = 'public'
          and p.parameter_mode = 'IN'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('a second user gets their OWN pair of rooms, not a shared one', async () => {
    const bobMap = await seedUsers(admin, ['Bob']);
    const aliceRows = await callAs<{ contract_chat_id: string; group_chat_id: string }>(
      u.Alice, 'select * from public.ensure_demo_world()',
    );
    const bobRows = await callAs<{ contract_chat_id: string; group_chat_id: string }>(
      bobMap.Bob, 'select * from public.ensure_demo_world()',
    );
    expect(aliceRows[0].contract_chat_id).not.toBe(bobRows[0].contract_chat_id);
    expect(aliceRows[0].group_chat_id).not.toBe(bobRows[0].group_chat_id);

    // And Bob is not a member of Alice's rooms, or vice versa.
    const aliceContractMembers = (
      await admin.query(`select user_id from public.chat_members where chat_id=$1`, [aliceRows[0].contract_chat_id])
    ).rows.map((r) => r.user_id);
    expect(aliceContractMembers).not.toContain(bobMap.Bob);
  });

  describe('the demo group is excluded from the ordinary default-group auto-join', () => {
    it('a THIRD new signup does not land in an earlier user\'s demo group', async () => {
      await callAs(u.Alice, 'select * from public.ensure_demo_world()');
      // A brand-new profile insert fires private.join_default_groups(). If the
      // exclusion in 0020 were missing, Carol would be auto-joined to Alice's
      // demo group, because it is type='group' with no clearance requirement —
      // exactly what the default-join trigger otherwise looks for.
      const carolMap = await seedUsers(admin, ['Carol']);
      const memberships = await callAs(carolMap.Carol, 'select chat_id from public.chat_members');
      const { rows: demoChats } = await admin.query(`select id from public.chats where is_demo = true`);
      const demoIds = new Set(demoChats.map((r) => r.id));
      expect(memberships.some((m) => demoIds.has((m as { chat_id: string }).chat_id))).toBe(false);
    });

    // The inverse of the test above, and the bug 0022 actually fixes: 0020
    // excluded a demo CHAT as a join *target*, but nothing excluded a demo
    // profile as the new *member* — so creating a demo/showcase persona
    // (scripts/seed-demo-personas.mjs, scripts/seed-showcase-accounts.mjs)
    // silently added it to every real user's real ungated group. Found by
    // querying chat_members for three freshly-created showcase accounts and
    // seeing six unexpected rows, not by reading the trigger in advance.
    it('a new DEMO profile does not land in an existing REAL ungated group', async () => {
      const { rows: realGroup } = await admin.query(
        `insert into public.chats (type, name, created_by) values ('group', 'Watercooler', $1) returning id`,
        [u.Alice],
      );
      await admin.query(
        `insert into public.chat_members (chat_id, user_id) values ($1, $2)`,
        [realGroup[0].id, u.Alice],
      );

      const { rows: persona } = await admin.query(
        `insert into auth.users (email) values ('jordan.demo.test@quorum.dev') returning id`,
      );
      await admin.query(
        `insert into public.profiles (id, display_name, is_demo) values ($1, 'Jordan (test)', true)`,
        [persona[0].id],
      );

      const { rows: memberships } = await admin.query(
        `select chat_id from public.chat_members where user_id = $1`,
        [persona[0].id],
      );
      expect(memberships.some((m) => m.chat_id === realGroup[0].id)).toBe(false);
    });

    it('a new REAL profile is still auto-joined as before — the exclusion is demo-only', async () => {
      const { rows: realGroup } = await admin.query(
        `insert into public.chats (type, name, created_by) values ('group', 'Watercooler', $1) returning id`,
        [u.Alice],
      );
      await admin.query(
        `insert into public.chat_members (chat_id, user_id) values ($1, $2)`,
        [realGroup[0].id, u.Alice],
      );

      const bobMap = await seedUsers(admin, ['Bob']);
      const { rows: memberships } = await admin.query(
        `select chat_id from public.chat_members where user_id = $1`,
        [bobMap.Bob],
      );
      expect(memberships.some((m) => m.chat_id === realGroup[0].id)).toBe(true);
    });
  });

  describe('reset_demo_world()', () => {
    it('deletes the caller\'s demo chats', async () => {
      const rows = await callAs<{ contract_chat_id: string; group_chat_id: string }>(
        u.Alice, 'select * from public.ensure_demo_world()',
      );
      await callAs(u.Alice, 'select public.reset_demo_world()');

      const { rows: remaining } = await admin.query(
        `select id from public.chats where id = any($1)`,
        [[rows[0].contract_chat_id, rows[0].group_chat_id]],
      );
      expect(remaining).toHaveLength(0);
    });

    it('cascades — messages and memory in the demo room go with it', async () => {
      const rows = await callAs<{ contract_chat_id: string }>(u.Alice, 'select * from public.ensure_demo_world()');
      const before = await admin.query(`select count(*)::int n from public.messages where chat_id=$1`, [rows[0].contract_chat_id]);
      expect(before.rows[0].n).toBeGreaterThan(0);

      await callAs(u.Alice, 'select public.reset_demo_world()');
      const after = await admin.query(`select count(*)::int n from public.messages where chat_id=$1`, [rows[0].contract_chat_id]);
      expect(after.rows[0].n).toBe(0);
    });

    it('running ensure_demo_world() again afterward rebuilds a fresh pair', async () => {
      await callAs(u.Alice, 'select * from public.ensure_demo_world()');
      await callAs(u.Alice, 'select public.reset_demo_world()');
      const rebuilt = await callAs<{ created: boolean }>(u.Alice, 'select * from public.ensure_demo_world()');
      expect(rebuilt[0].created).toBe(true);
    });

    // The bug 0023 fixes: a standing showcase room (scripts/seed-showcase-
    // accounts.mjs) is `is_demo = true` — so the default-group auto-join
    // trigger leaves it alone — but has `demo_kind = null`, unlike the
    // per-visitor contract/isolation rooms. reset_demo_world() must tell the
    // two apart, or a visitor signed in as a showcase account could delete
    // the standing world by clicking "Reset demo" on their own account page.
    it('CANNOT touch an is_demo room with no demo_kind — a standing showcase room', async () => {
      const { rows: chat } = await admin.query(
        `insert into public.chats (type, name, created_by, is_demo) values ('group','Litigation Support',$1,true) returning id`,
        [u.Alice],
      );
      await admin.query(
        `insert into public.chat_members (chat_id, user_id) values ($1,$2)`,
        [chat[0].id, u.Alice],
      );

      await callAs(u.Alice, 'select public.reset_demo_world()');

      const { rows: stillThere } = await admin.query(`select id from public.chats where id=$1`, [chat[0].id]);
      expect(stillThere).toHaveLength(1);
    });

    it('CANNOT touch a non-demo chat, even one the caller is a member of', async () => {
      const { rows: chat } = await admin.query(
        `insert into public.chats (type, name, created_by) values ('group','Real Group',$1) returning id`,
        [u.Alice],
      );
      await admin.query(
        `insert into public.chat_members (chat_id, user_id) values ($1,$2)`,
        [chat[0].id, u.Alice],
      );

      await callAs(u.Alice, 'select public.reset_demo_world()');

      const { rows: stillThere } = await admin.query(`select id from public.chats where id=$1`, [chat[0].id]);
      expect(stillThere).toHaveLength(1);
    });

    it('CANNOT touch another user\'s demo world', async () => {
      const bobMap = await seedUsers(admin, ['Bob']);
      const bobRows = await callAs<{ contract_chat_id: string }>(bobMap.Bob, 'select * from public.ensure_demo_world()');

      await callAs(u.Alice, 'select public.reset_demo_world()'); // Alice has no demo world of her own

      const { rows: bobsRoomStillExists } = await admin.query(
        `select id from public.chats where id=$1`, [bobRows[0].contract_chat_id],
      );
      expect(bobsRoomStillExists).toHaveLength(1);
    });

    it('takes no parameter either', async () => {
      const { rows } = await admin.query(
        `select count(*)::int n from information_schema.parameters p
           join information_schema.routines r on r.specific_name = p.specific_name
          where r.routine_name = 'reset_demo_world' and r.routine_schema = 'public'
            and p.parameter_mode = 'IN'`,
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
