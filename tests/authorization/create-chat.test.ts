import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asSuper } from '../db/harness';
import { seedUsers, seedClearances, truncateAll, grantClearance, type UserMap, type ClearanceMap } from '../db/fixtures';

/**
 * Chat creation.
 *
 * `create_chat()` is SECURITY DEFINER, so it bypasses RLS and must do all of
 * its own validation. Everything the policies would have enforced has to be
 * enforced here instead, which is why this suite exists.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;

beforeAll(async () => { admin = await asSuper(); });
afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol']);
  await grantClearance(admin, u.Alice, cl.confidential);
});

async function create(
  actor: string,
  args: { type: string; name?: string | null; members?: string[]; clearance?: string | null },
) {
  const c = await asUser(actor);
  try {
    const res = await c.query(
      'select public.create_chat($1::public.chat_type,$2,$3::uuid[],$4) as id',
      [args.type, args.name ?? null, args.members ?? [], args.clearance ?? null],
    );
    return res.rows[0].id as string;
  } finally {
    await c.end();
  }
}

describe('the creator is seated automatically', () => {
  it('a group creator becomes an admin member', async () => {
    const id = await create(u.Alice, { type: 'group', name: 'Team', members: [u.Bob] });
    const rows = await admin.query(
      'select user_id, role, status from public.chat_members where chat_id=$1 order by role', [id]);
    expect(rows.rowCount).toBe(2);
    const alice = rows.rows.find((r) => r.user_id === u.Alice);
    expect(alice).toMatchObject({ role: 'admin', status: 'member' });
  });

  it('a DM has no admins — DMs are not administered', async () => {
    const id = await create(u.Alice, { type: 'dm', members: [u.Bob] });
    const rows = await admin.query('select role from public.chat_members where chat_id=$1', [id]);
    expect(rows.rows.every((r) => r.role === 'member')).toBe(true);
  });

  it('passing yourself in the member list is harmless, not a key violation', async () => {
    const id = await create(u.Alice, { type: 'group', name: 'Team', members: [u.Alice, u.Bob] });
    const rows = await admin.query('select count(*)::int n from public.chat_members where chat_id=$1', [id]);
    expect(rows.rows[0].n).toBe(2);
  });
});

describe('the minimum-two-users rule from the brief', () => {
  it('a DM must have exactly two people', async () => {
    await expect(create(u.Alice, { type: 'dm', members: [] })).rejects.toThrow(/exactly two/i);
    await expect(create(u.Alice, { type: 'dm', members: [u.Bob, u.Carol] })).rejects.toThrow(/exactly two/i);
  });

  it('a group needs at least two people', async () => {
    await expect(create(u.Alice, { type: 'group', name: 'Lonely', members: [] }))
      .rejects.toThrow(/at least two/i);
  });

  it('a group needs a name', async () => {
    await expect(create(u.Alice, { type: 'group', name: '   ', members: [u.Bob] }))
      .rejects.toThrow(/needs a name/i);
  });

  it('an agent chat is the documented exception — exactly one human', async () => {
    const id = await create(u.Alice, { type: 'agent', name: 'Notes' });
    const rows = await admin.query('select count(*)::int n from public.chat_members where chat_id=$1', [id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('an agent chat rejects a second human', async () => {
    await expect(create(u.Alice, { type: 'agent', members: [u.Bob] }))
      .rejects.toThrow(/exactly one/i);
  });
});

describe('clearance', () => {
  it('you cannot create a chat above your own clearance', async () => {
    // Otherwise you could gate a room above your level and lock yourself out of
    // something you own — and not even be able to see that it exists.
    await expect(create(u.Bob, { type: 'group', name: 'Secret', members: [u.Alice], clearance: cl.restricted }))
      .rejects.toThrow(/above your own clearance/i);
  });

  it('you can create one at or below your clearance', async () => {
    const id = await create(u.Alice, {
      type: 'group', name: 'Confidential', members: [u.Bob], clearance: cl.confidential });
    expect(id).toBeTruthy();
  });

  it('a DM cannot be clearance-gated', async () => {
    await expect(create(u.Alice, { type: 'dm', members: [u.Bob], clearance: cl.confidential }))
      .rejects.toThrow(/cannot be clearance-gated/i);
  });

  it('an unknown clearance is refused', async () => {
    await expect(create(u.Alice, {
      type: 'group', name: 'X', members: [u.Bob],
      clearance: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(/unknown clearance/i);
  });
});

describe('participants', () => {
  it('an unknown participant is refused before the chat row is written', async () => {
    await expect(create(u.Alice, {
      type: 'group', name: 'Ghosts', members: ['00000000-0000-0000-0000-000000000000'],
    })).rejects.toThrow(/unknown participant/i);

    const chats = await admin.query('select count(*)::int n from public.chats');
    expect(chats.rows[0].n).toBe(0);
  });

  it('a failed creation leaves NO orphaned chat', async () => {
    // A chat with no members is the zero-active-members case the memory
    // fail-closed guard exists for. Better never to create it.
    await expect(create(u.Alice, { type: 'group', name: '', members: [u.Bob] })).rejects.toThrow();
    const chats = await admin.query('select count(*)::int n from public.chats');
    expect(chats.rows[0].n).toBe(0);
  });
});

describe('the created chat is immediately usable by its members', () => {
  it('members can read it and non-members cannot', async () => {
    const id = await create(u.Alice, { type: 'dm', members: [u.Bob] });

    for (const who of ['Alice', 'Bob']) {
      const c = await asUser(u[who]);
      try {
        const r = await c.query('select count(*)::int n from public.chats where id=$1', [id]);
        expect(r.rows[0].n, who).toBe(1);
      } finally { await c.end(); }
    }

    const c = await asUser(u.Carol);
    try {
      const r = await c.query('select count(*)::int n from public.chats where id=$1', [id]);
      expect(r.rows[0].n).toBe(0);
    } finally { await c.end(); }
  });
});
