import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asSuper } from '../db/harness';
import { seedUsers, seedClearances, grantClearance, truncateAll, type UserMap, type ClearanceMap } from '../db/fixtures';

/**
 * Granting and revoking clearances.
 *
 * This is the delegation surface, and delegation is where an authorisation axis
 * usually dies: if a level-1 user can mint level-3, the ladder is decoration.
 * Every test here is about that.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;

beforeAll(async () => { admin = await asSuper(); });
afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Exec', 'Mid', 'Junior', 'Nobody']);
  await grantClearance(admin, u.Exec, cl.restricted);     // level 3
  await grantClearance(admin, u.Mid, cl.confidential);    // level 2
  await grantClearance(admin, u.Junior, cl.internal);     // level 1
  // Nobody holds nothing.
});

async function callAs(actor: string, sql: string, args: unknown[]) {
  const c = await asUser(actor);
  try { return await c.query(sql, args); } finally { await c.end(); }
}

const grant = (actor: string, target: string, clearance: string) =>
  callAs(actor, 'select public.grant_clearance($1,$2)', [target, clearance]);
const revoke = (actor: string, target: string, clearance: string) =>
  callAs(actor, 'select public.revoke_clearance($1,$2)', [target, clearance]);

const holds = async (user: string, clearance: string) =>
  (await admin.query(
    'select count(*)::int n from public.user_clearances where user_id=$1 and clearance_id=$2',
    [user, clearance])).rows[0].n === 1;

describe('you cannot grant above your own level', () => {
  it('a level-2 user cannot grant level 3', async () => {
    // The escalation this blocks: mint a high clearance for a confederate, then
    // read everything through them.
    await expect(grant(u.Mid, u.Junior, cl.restricted))
      .rejects.toThrow(/above your own/i);
    expect(await holds(u.Junior, cl.restricted)).toBe(false);
  });

  it('a user with NO clearance cannot grant anything', async () => {
    await expect(grant(u.Nobody, u.Junior, cl.general))
      .rejects.toThrow(/above your own/i);
  });

  it('and cannot grant to themselves', async () => {
    // Self-granting would make clearance a checkbox rather than an axis.
    await expect(grant(u.Nobody, u.Nobody, cl.restricted))
      .rejects.toThrow(/above your own/i);
    await expect(grant(u.Junior, u.Junior, cl.restricted))
      .rejects.toThrow(/above your own/i);
  });
});

describe('you can grant at or below your own level', () => {
  it('a level-3 user can grant level 3', async () => {
    // At-level rather than strictly-below: a peer onboarding a peer is the
    // common case, and forbidding it would make the top rung ungrantable.
    await grant(u.Exec, u.Nobody, cl.restricted);
    expect(await holds(u.Nobody, cl.restricted)).toBe(true);
  });

  it('a level-3 user can grant a lower level', async () => {
    await grant(u.Exec, u.Nobody, cl.internal);
    expect(await holds(u.Nobody, cl.internal)).toBe(true);
  });

  it('granting twice is idempotent, not an error', async () => {
    await grant(u.Exec, u.Nobody, cl.internal);
    await expect(grant(u.Exec, u.Nobody, cl.internal)).resolves.toBeDefined();
  });

  it('a granted clearance immediately changes what the user can see', async () => {
    // The point of the whole exercise: the grant is not bookkeeping.
    const gated = await admin.query(
      `insert into public.chats (type, name, created_by, required_clearance_id)
       values ('group','Gated',$1,$2) returning id`, [u.Exec, cl.confidential]);
    const chatId = gated.rows[0].id;
    await admin.query(
      `insert into public.chat_members (chat_id, user_id, status) values ($1,$2,'member')`,
      [chatId, u.Nobody]);

    const before = await callAs(u.Nobody, 'select count(*)::int n from public.chats where id=$1', [chatId]);
    expect(before.rows[0].n).toBe(0);

    await grant(u.Exec, u.Nobody, cl.confidential);

    const after = await callAs(u.Nobody, 'select count(*)::int n from public.chats where id=$1', [chatId]);
    expect(after.rows[0].n).toBe(1);
  });
});

describe('revocation follows the same rule, with one exception', () => {
  it('a level-2 user cannot revoke a level-3 clearance from someone else', async () => {
    await expect(revoke(u.Mid, u.Exec, cl.restricted)).rejects.toThrow(/above your own/i);
    expect(await holds(u.Exec, cl.restricted)).toBe(true);
  });

  it('a higher user can revoke from a lower one', async () => {
    await revoke(u.Exec, u.Junior, cl.internal);
    expect(await holds(u.Junior, cl.internal)).toBe(false);
  });

  it('anyone may revoke their OWN clearance, at any level', async () => {
    // Giving up access you hold needs nobody's permission.
    await revoke(u.Exec, u.Exec, cl.restricted);
    expect(await holds(u.Exec, cl.restricted)).toBe(false);
  });
});

describe('validation', () => {
  it('an unknown user is refused', async () => {
    await expect(grant(u.Exec, '00000000-0000-0000-0000-000000000000', cl.internal))
      .rejects.toThrow(/unknown user/i);
  });

  it('an unknown clearance is refused', async () => {
    await expect(grant(u.Exec, u.Nobody, '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/unknown clearance/i);
  });

  it('the table still has no direct write policy — the RPC is the only path', async () => {
    const c = await asUser(u.Exec);
    try {
      await expect(c.query(
        'insert into public.user_clearances (user_id, clearance_id) values ($1,$2)',
        [u.Nobody, cl.restricted],
      )).rejects.toThrow(/row-level security/i);
    } finally { await c.end(); }
  });
});

describe('bootstrap — the empty-workspace deadlock', () => {
  it('a user holding nothing can claim the BASE rung', async () => {
    // Without this, the first user in a fresh workspace holds nothing, so under
    // the grant rule nobody could ever grant anything and the ladder would be
    // permanently unusable.
    await callAs(u.Nobody, 'select public.claim_base_clearance()', []);
    expect(await holds(u.Nobody, cl.general)).toBe(true);
  });

  it('it grants ONLY the base rung, never anything higher', async () => {
    // Safe precisely because level 0 gates nothing: an ungated chat already
    // requires level 0.
    await callAs(u.Nobody, 'select public.claim_base_clearance()', []);
    expect(await holds(u.Nobody, cl.internal)).toBe(false);
    expect(await holds(u.Nobody, cl.restricted)).toBe(false);
  });

  it('it is a no-op for someone who already holds a clearance', async () => {
    // Otherwise a level-3 user calling it would silently acquire a redundant
    // row, and worse, it would be a path to re-acquire something just revoked.
    await callAs(u.Junior, 'select public.claim_base_clearance()', []);
    expect(await holds(u.Junior, cl.general)).toBe(false);
    expect(await holds(u.Junior, cl.internal)).toBe(true);
  });
});
