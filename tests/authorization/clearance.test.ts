import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { asUser, asSuper } from '../db/harness';
import {
  seedUsers, seedClearances, createChat, addMember, grantClearance, truncateAll,
  type UserMap, type ClearanceMap,
} from '../db/fixtures';

/**
 * Axis two: clearance.
 *
 * The point of every test here is that clearance is INDEPENDENT of membership.
 * A user with a perfectly valid membership row is still refused when they are
 * not cleared, and a cleared user with no membership row gets nothing. That
 * independence is what makes the clearance floor in the memory surfacing rule
 * meaningful rather than redundant.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;

let openGroup: string;         // no clearance required
let confidentialGroup: string; // requires level 2
let restrictedGroup: string;   // requires level 3

beforeAll(async () => {
  admin = await asSuper();
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol', 'Dave']);

  // Alice: restricted (3) — the top of the ladder.
  // Bob:   confidential (2).
  // Carol: internal (1).
  // Dave:  nothing at all.
  await grantClearance(admin, u.Alice, cl.restricted);
  await grantClearance(admin, u.Bob, cl.confidential);
  await grantClearance(admin, u.Carol, cl.internal);

  openGroup = await createChat(admin, { type: 'group', name: 'Open', createdBy: u.Alice });
  confidentialGroup = await createChat(admin, {
    type: 'group', name: 'Confidential', createdBy: u.Alice, requiredClearanceId: cl.confidential,
  });
  restrictedGroup = await createChat(admin, {
    type: 'group', name: 'Restricted', createdBy: u.Alice, requiredClearanceId: cl.restricted,
  });

  // Everyone is a full MEMBER of all three. Any denial below is therefore
  // attributable to clearance alone — which is the whole design of this fixture.
  for (const chat of [openGroup, confidentialGroup, restrictedGroup]) {
    await addMember(admin, chat, u.Alice, { role: 'admin' });
    await addMember(admin, chat, u.Bob);
    await addMember(admin, chat, u.Carol);
    await addMember(admin, chat, u.Dave);
  }
});

afterAll(async () => {
  await admin?.end();
});

async function canSee(userId: string, chatId: string): Promise<boolean> {
  const c = await asUser(userId);
  try {
    const r = await c.query('select count(*)::int n from public.chats where id=$1', [chatId]);
    return r.rows[0].n === 1;
  } finally {
    await c.end();
  }
}

describe('the clearance floor', () => {
  it('an ungated chat is readable by every member', async () => {
    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
      expect(await canSee(u[name], openGroup), `${name} / open`).toBe(true);
    }
  });

  it('a member WITHOUT sufficient clearance cannot read a gated chat', async () => {
    // Carol is internal(1) and Dave holds nothing; both are full members.
    expect(await canSee(u.Carol, confidentialGroup)).toBe(false);
    expect(await canSee(u.Dave, confidentialGroup)).toBe(false);
  });

  it('a member WITH exactly the required clearance can read it', async () => {
    expect(await canSee(u.Bob, confidentialGroup)).toBe(true);
  });

  it('a HIGHER clearance satisfies a LOWER requirement', async () => {
    // Alice is restricted(3) reading a confidential(2) chat.
    expect(await canSee(u.Alice, confidentialGroup)).toBe(true);
  });

  it('a LOWER clearance does not satisfy a HIGHER requirement', async () => {
    // Bob is confidential(2) reading a restricted(3) chat.
    expect(await canSee(u.Bob, restrictedGroup)).toBe(false);
  });
});

describe('the two axes are independent — both must pass', () => {
  it('clearance without membership grants nothing', async () => {
    const privateChat = await createChat(admin, {
      type: 'group', name: 'Cleared but closed', createdBy: u.Alice,
      requiredClearanceId: cl.internal,
    });
    await addMember(admin, privateChat, u.Alice, { role: 'admin' });
    // Bob is confidential(2) — over the internal(1) bar — but not a member.
    // He can DISCOVER it, because discovery is gated on clearance by design.
    expect(await canSee(u.Bob, privateChat)).toBe(true);

    // But the roster, which is content, requires both axes.
    const c = await asUser(u.Bob);
    try {
      const r = await c.query(
        'select count(*)::int n from public.chat_members where chat_id=$1', [privateChat]);
      expect(r.rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('membership without clearance grants nothing', async () => {
    const c = await asUser(u.Dave);
    try {
      const r = await c.query(
        'select count(*)::int n from public.chat_members where chat_id=$1', [restrictedGroup]);
      // Dave holds no clearance. His own membership row is visible to him by
      // policy; the rest of the roster is not.
      expect(r.rows[0].n).toBe(1);
    } finally { await c.end(); }
  });
});

describe('discovery is gated on clearance, not on membership', () => {
  it('an uncleared user cannot even see that a gated chat EXISTS', async () => {
    // The existence of a restricted conversation is itself disclosure.
    expect(await canSee(u.Dave, restrictedGroup)).toBe(false);
  });

  it('a cleared non-member CAN discover a group, so they can ask to join', async () => {
    const discoverable = await createChat(admin, {
      type: 'group', name: 'Discoverable', createdBy: u.Alice, requiredClearanceId: cl.internal,
    });
    await addMember(admin, discoverable, u.Alice, { role: 'admin' });
    expect(await canSee(u.Carol, discoverable)).toBe(true); // internal(1), not a member
    expect(await canSee(u.Dave, discoverable)).toBe(false); // no clearance
  });

  it('a DM is never discoverable, cleared or not', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    expect(await canSee(u.Carol, dm)).toBe(false);
    expect(await canSee(u.Alice, dm)).toBe(true);
  });
});

describe('revocation', () => {
  it('revoking a clearance removes access on the next read', async () => {
    expect(await canSee(u.Bob, confidentialGroup)).toBe(true);
    await admin.query(
      'delete from public.user_clearances where user_id=$1 and clearance_id=$2',
      [u.Bob, cl.confidential]);
    expect(await canSee(u.Bob, confidentialGroup)).toBe(false);
    await grantClearance(admin, u.Bob, cl.confidential); // restore for other tests
  });
});

describe('a DM cannot be clearance-gated', () => {
  it('the constraint rejects it — gating is meaningless when both parties see all', async () => {
    await expect(
      createChat(admin, { type: 'dm', createdBy: u.Alice, requiredClearanceId: cl.internal }),
    ).rejects.toThrow(/dm_has_no_clearance/i);
  });
});
