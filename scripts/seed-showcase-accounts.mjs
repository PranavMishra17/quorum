#!/usr/bin/env node
/**
 * Create the two showcase accounts — "Jordan Reyes" and "Morgan Blake" — and
 * their pre-built world: several rooms, real message history, and memory
 * already written, so `/auth/showcase?user=jordan` drops a visitor straight
 * into something rich instead of an empty inbox.
 *
 *   pnpm seed:showcase
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE TO RUN AGAINST PRODUCTION, AND WHAT IT IS NOT
 *
 * These are real, ordinary authenticated accounts — not a privilege
 * escalation, not a bypass of RLS, not a shared password across many
 * developers (see `seed-dev.mjs`, which refuses production for exactly that
 * reason). The two things that make exposing them on the live landing page
 * acceptable:
 *
 *   1. Every other person in every room they're in — "Casey Nolan" below — is
 *      also a seeded, non-sign-in-able identity. There is no real user's data
 *      reachable from either account.
 *   2. `profiles.is_showcase` (and the `is_demo` it implies) excludes both
 *      from the Directory, New-group, and clearance-granting lists, so they
 *      cannot be accidentally added to somebody's real conversation.
 *
 * Run this ONCE per environment. It is idempotent: if Jordan's world already
 * exists, this prints that and exits without touching anything.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* rely on the ambient environment */
  }
}
loadEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const PASSWORD = process.env.SHOWCASE_ACCOUNT_PASSWORD;
if (!URL || !SECRET || !PASSWORD) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and SHOWCASE_ACCOUNT_PASSWORD are required.\n' +
      'SHOWCASE_ACCOUNT_PASSWORD is what /auth/showcase signs these two accounts in with — pick a\n' +
      'real, unguessable value; unlike the dev-login password, this route is not closed in production.',
  );
  process.exit(1);
}

const db = createClient(URL, SECRET, { auth: { persistSession: false } });

const PALETTE = [
  '#e06c75', '#d19a66', '#e5c07b', '#98c379',
  '#56b6c2', '#61afef', '#c678dd', '#be5046',
];
function colorFor(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

async function ensureUser({ email, name, password, profile }) {
  const { data: existing } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = existing?.users?.find((u) => u.email === email);

  let userId = found?.id;
  if (!userId) {
    const { data, error } = await db.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: name },
    });
    if (error) throw new Error(`could not create ${email}: ${error.message}`);
    userId = data.user.id;
    console.log(`created auth user   ${email}  (${userId})`);
  } else {
    console.log(`auth user exists    ${email}  (${userId})`);
  }

  const { error: profileError } = await db.from('profiles').upsert(
    { id: userId, display_name: name, color: colorFor(userId), ...profile },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(`could not upsert profile for ${email}: ${profileError.message}`);

  return userId;
}

const jordanId = await ensureUser({
  email: 'jordan.demo@quorum.dev',
  name: 'Jordan Reyes',
  password: PASSWORD,
  profile: {
    is_demo: true,
    is_showcase: true,
    showcase_key: 'jordan',
    showcase_title: 'Senior Associate — M&A',
    showcase_note: '3 rooms, one confidential — deep memory on an active deal',
  },
});

const morganId = await ensureUser({
  email: 'morgan.demo@quorum.dev',
  name: 'Morgan Blake',
  password: PASSWORD,
  profile: {
    is_demo: true,
    is_showcase: true,
    showcase_key: 'morgan',
    showcase_title: 'Paralegal — Litigation Support',
    showcase_note: 'Shares a room with Jordan — see what crosses over, and what doesn\'t',
  },
});

// Casey never signs in — a seeded co-worker for room texture, same idea as
// "Sam" in the per-visitor demo world (migration 0020), just not offered on
// the landing page.
const caseyId = await ensureUser({
  email: 'casey.demo@quorum.dev',
  name: 'Casey Nolan',
  password: `showcase-${crypto.randomUUID()}`, // unusable — no sign-in path exists for this account
  profile: { is_demo: true },
});

// Idempotency: keyed on the one room this script itself creates and nothing
// else does, not on "Jordan is a member of anything" — the default-group
// auto-join trigger (or a future one) can add unrelated memberships, and
// those must never be mistaken for "the showcase world already exists".
const { data: existingDeal } = await db
  .from('chats')
  .select('id')
  .eq('name', 'Meridian Deal Team')
  .eq('created_by', jordanId)
  .maybeSingle();

if (existingDeal) {
  console.log('\nShowcase world already exists for Jordan — nothing more to do.');
  process.exit(0);
}

const { data: clearanceRows, error: clearanceError } = await db
  .from('clearances')
  .select('id, key');
if (clearanceError) throw new Error(`could not read clearances: ${clearanceError.message}`);
const clearanceId = Object.fromEntries(clearanceRows.map((c) => [c.key, c.id]));

// Jordan is cleared for the confidential room he's about to be seeded into;
// Morgan is not — enough to see clearance, on its own, block a read even
// setting membership aside.
await db.from('user_clearances').insert([
  { user_id: jordanId, clearance_id: clearanceId.confidential },
  { user_id: morganId, clearance_id: clearanceId.internal },
]);
console.log('clearances granted   Jordan -> confidential, Morgan -> internal');

async function createRoom({ type, name, requiredClearanceKey, createdBy, members }) {
  const { data: chat, error } = await db
    .from('chats')
    .insert({
      type,
      name: name ?? null,
      created_by: createdBy,
      required_clearance_id: requiredClearanceKey ? clearanceId[requiredClearanceKey] : null,
      // Excludes these from the ordinary default-group auto-join (every new
      // signup was otherwise silently added to "Litigation Support" — found
      // from a real screenshot showing nine members on a room meant to hold
      // three). `demo_kind` stays null, which is what keeps reset_demo_world()
      // (migration 0023) from ever touching these on any visitor's behalf.
      is_demo: true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`could not create room "${name}": ${error.message}`);

  await db.from('chat_members').insert(
    members.map(({ userId, role }) => ({
      chat_id: chat.id, user_id: userId, role: role ?? 'member', status: 'member', joined_at: new Date().toISOString(),
    })),
  );
  console.log(`room created         ${name ?? '(dm)'}  (${chat.id})`);
  return chat.id;
}

async function seedMessage(chatId, senderId, content, daysAgo) {
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('messages').insert({
    chat_id: chatId, sender_type: 'user', sender_id: senderId, content, created_at: createdAt,
  });
  if (error) throw new Error(`could not seed message in ${chatId}: ${error.message}`);
}

async function seedMemory(subjectId, chatId, content, clearanceLevel) {
  const { error } = await db.rpc('write_memory_item', {
    p_subject_user_id: subjectId,
    p_origin_chat_id: chatId,
    p_origin_message_id: null,
    p_content: content,
    p_clearance_level: clearanceLevel,
    p_source_type: 'stated',
    p_confidence: 1,
    p_status: 'active',
    p_expires_at: null,
  });
  if (error) throw new Error(`could not seed memory for ${subjectId}: ${error.message}`);
}

// --- Room 1: Jordan <-> Morgan DM (general) ---------------------------------
const dmId = await createRoom({
  type: 'dm', name: null, createdBy: jordanId,
  members: [{ userId: jordanId }, { userId: morganId }],
});
await seedMessage(dmId, jordanId, 'Can you get the discovery index over to me before Thursday?', 6);
await seedMessage(dmId, morganId, 'Yep — batching it with the Henlow filings, same run.', 6);
await seedMessage(dmId, jordanId, "I review filings in batches Monday mornings, by the way — no need to rush anything to me over a weekend.", 5);
await seedMemory(jordanId, dmId, 'Jordan reviews filings in batches on Monday mornings, not urgently over weekends.', 0);
await seedMemory(morganId, dmId, "Morgan is out of office the last week of the month.", 0);

// --- Room 2: Meridian Deal Team (confidential — Jordan + Casey only) --------
const dealId = await createRoom({
  type: 'group', name: 'Meridian Deal Team', requiredClearanceKey: 'confidential', createdBy: jordanId,
  members: [{ userId: jordanId, role: 'admin' }, { userId: caseyId }],
});
await seedMessage(dealId, caseyId, "Redlines from the other side are in — mostly the exclusivity clause, they want 60 days instead of 45.", 4);
await seedMessage(dealId, jordanId, "Push back to 45. The exclusivity period ends March 14 either way — that's the date we've told the board.", 4);
await seedMessage(dealId, caseyId, "Got it. I'll have the counter back to them by end of day.", 3);
await seedMemory(jordanId, dealId, "The Meridian deal's exclusivity period ends March 14 — the board has been told that date.", 2);
await seedMemory(jordanId, dealId, "Jordan is holding firm on a 45-day exclusivity window against the other side's 60-day ask.", 2);

// --- Room 3: Litigation Support (general — Jordan, Morgan, Casey) ----------
const litId = await createRoom({
  type: 'group', name: 'Litigation Support', createdBy: jordanId,
  members: [{ userId: jordanId, role: 'admin' }, { userId: morganId }, { userId: caseyId }],
});
await seedMessage(litId, morganId, "Three discovery deadlines open this month — Henlow, Park Ave, and the Reyes matter.", 5);
await seedMessage(litId, jordanId, "Flag me if Henlow slips — that's the one with the tight judge.", 5);
await seedMemory(morganId, litId, "Morgan is tracking three open discovery deadlines this month: Henlow, Park Ave, and the Reyes matter.", 0);

console.log('\nShowcase accounts ready.');
console.log('Sign in at /auth/showcase?user=jordan or /auth/showcase?user=morgan');
console.log(
  '\nTry asking the agent about the Meridian exclusivity date in Litigation Support (general) vs\n' +
  'Meridian Deal Team (confidential, Jordan-only) — same question, same account, different answer.',
);
