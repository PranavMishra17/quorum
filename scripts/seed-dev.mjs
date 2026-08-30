#!/usr/bin/env node
/**
 * Seed the development world.
 *
 *   pnpm seed:dev
 *
 * Creates ~55 accounts, grants clearances across the ladder, and builds a set
 * of chats chosen so the authorisation model is visible by clicking around
 * rather than by being walked through it.
 *
 * The first five accounts are the demo cast — they appear on the sign-in page
 * and each one exists to make a specific claim checkable. The remaining fifty
 * are there so the app is populated: a twenty-person group behaves differently
 * from a three-person one, and the per-subject memory cap only means something
 * when there are enough subjects to crowd each other out.
 *
 * Idempotent — safe to run repeatedly. Refuses to run against production: it
 * creates accounts with a known shared password, which is fine in a dev project
 * and an incident anywhere else.
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

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to seed a production environment');
  process.exit(1);
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!URL || !SECRET) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required.\n' +
      'Copy .env.example to .env.local and fill it in — see docs/SETUP-SUPABASE.md.',
  );
  process.exit(1);
}

const db = createClient(URL, SECRET, { auth: { persistSession: false } });
const PASSWORD = 'quorum-dev-password-not-a-secret';

// --- The demo cast --------------------------------------------------------
// These five appear on the sign-in page. Each exists to make one claim
// checkable without explanation.
const CAST = [
  { key: 'alice', name: 'Alice Nakamura',  clearance: 'restricted' },
  { key: 'bob',   name: 'Bob Oyelaran',    clearance: 'confidential' },
  { key: 'carol', name: 'Carol Whitfield', clearance: 'internal' },
  { key: 'dana',  name: 'Dana Iqbal',      clearance: null },
  { key: 'erin',  name: 'Erin Vasquez',    clearance: 'general' },
];

// --- The rest of the workspace -------------------------------------------
const FIRST = [
  'Priya', 'Tomás', 'Wei', 'Amara', 'Jonas', 'Leila', 'Kwame', 'Sofia', 'Ravi', 'Ingrid',
  'Mateo', 'Yuki', 'Nadia', 'Olumide', 'Clara', 'Hassan', 'Freya', 'Diego', 'Anika', 'Lars',
  'Zara', 'Emeka', 'Marta', 'Kenji', 'Rosa', 'Bilal', 'Elena', 'Thabo', 'Julia', 'Omar',
  'Sanne', 'Ivan', 'Mei', 'Grace', 'Paulo', 'Farah', 'Niels', 'Aisha', 'Viktor', 'Nour',
  'Hana', 'Samuel', 'Lucia', 'Idris', 'Petra', 'Andre', 'Noor', 'Stefan', 'Rina', 'Malik',
];
const LAST = [
  'Raman', 'Silva', 'Chen', 'Okafor', 'Berg', 'Haddad', 'Mensah', 'Rossi', 'Kapoor', 'Lindqvist',
  'Alvarez', 'Tanaka', 'Petrov', 'Adeyemi', 'Novak', 'Karim', 'Sørensen', 'Moreno', 'Bhatt', 'Nilsen',
];

const EXTRAS = FIRST.map((first, i) => ({
  key: `${first.toLowerCase().replace(/[^a-z]/g, '')}${i}`,
  name: `${first} ${LAST[i % LAST.length]}`,
  // A realistic pyramid: most people hold internal or general, a few are
  // cleared higher. The distribution matters — if everyone were restricted,
  // the clearance floor would never visibly do anything.
  clearance:
    i % 17 === 0 ? 'restricted'
    : i % 5 === 0 ? 'confidential'
    : i % 3 === 0 ? 'general'
    : i % 11 === 0 ? null
    : 'internal',
}));

const USERS = [...CAST, ...EXTRAS].map((u) => ({
  ...u,
  email: `${u.key}@quorum.dev`,
}));

const PALETTE = ['#e06c75', '#d19a66', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#be5046'];
const colorFor = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

async function allAuthUsers() {
  const found = new Map();
  for (let page = 1; page <= 10; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    for (const u of users) found.set(u.email, u.id);
    if (users.length < 200) break;
  }
  return found;
}

async function chat(spec) {
  const { data: found } = await db
    .from('chats').select('id').eq('name', spec.name).maybeSingle();
  if (found) return found.id;

  const { data, error } = await db
    .from('chats')
    .insert({
      type: spec.type, name: spec.name, created_by: spec.createdBy,
      required_clearance_id: spec.clearanceId ?? null,
    })
    .select('id').single();
  if (error) throw new Error(`chat ${spec.name}: ${error.message}`);
  return data.id;
}

async function members(chatId, ids, adminId) {
  const rows = ids.map((id) => ({
    chat_id: chatId, user_id: id,
    role: id === adminId ? 'admin' : 'member',
    status: 'member', joined_at: new Date().toISOString(),
  }));
  const { error } = await db
    .from('chat_members').upsert(rows, { onConflict: 'chat_id,user_id' });
  if (error) throw new Error(`members: ${error.message}`);
}

async function say(chatId, senderId, content) {
  const { data: existing } = await db
    .from('messages').select('id').eq('chat_id', chatId).eq('content', content).maybeSingle();
  if (existing) return;
  const { error } = await db
    .from('messages')
    .insert({ chat_id: chatId, sender_type: 'user', sender_id: senderId, content });
  if (error) throw new Error(`message: ${error.message}`);
}

async function main() {
  const { data: clearances, error: clErr } = await db.from('clearances').select('id, key, level');
  if (clErr) throw new Error(`clearances: ${clErr.message} — have migrations been applied?`);
  const byKey = Object.fromEntries(clearances.map((c) => [c.key, c]));
  if (!byKey.restricted) throw new Error('clearance ladder not seeded; apply migration 0008');

  console.log(`\n  seeding ${USERS.length} accounts…`);
  const existing = await allAuthUsers();
  const id = {};

  for (const u of USERS) {
    let uid = existing.get(u.email);
    if (!uid) {
      const { data, error } = await db.auth.admin.createUser({
        email: u.email, password: PASSWORD, email_confirm: true,
        user_metadata: { full_name: u.name },
      });
      if (error) throw new Error(`createUser ${u.email}: ${error.message}`);
      uid = data.user.id;
    }
    id[u.key] = uid;

    await db.from('profiles').upsert(
      { id: uid, display_name: u.name, color: colorFor(uid) }, { onConflict: 'id' });

    if (u.clearance) {
      await db.from('user_clearances').upsert(
        { user_id: uid, clearance_id: byKey[u.clearance].id, granted_by: id.alice ?? uid },
        { onConflict: 'user_id,clearance_id' });
    }
  }
  console.log('  accounts done');

  const others = EXTRAS.map((u) => id[u.key]);
  const at = (n) => others[n % others.length];
  const range = (from, to) => others.slice(from, to);

  // --- The chats that demonstrate the model ------------------------------

  // 1 & 2. IDENTICAL member sets, different clearance levels. The pair that
  // makes the clearance floor non-redundant: containment holds in both
  // directions, so only the floor stops a deal-room fact reaching the general
  // room.
  const dealRoom = await chat({
    type: 'group', name: 'Deal Room', createdBy: id.alice, clearanceId: byKey.confidential.id });
  await members(dealRoom, [id.alice, id.bob], id.alice);

  const watercooler = await chat({ type: 'group', name: 'Watercooler', createdBy: id.alice });
  await members(watercooler, [id.alice, id.bob], id.alice);

  // 3. Membership WITHOUT clearance. Dana is a full member and sees nothing.
  const legalOps = await chat({
    type: 'group', name: 'Legal Ops', createdBy: id.alice, clearanceId: byKey.confidential.id });
  await members(legalOps, [id.alice, id.bob, id.dana], id.alice);

  // 4. A big group — twenty people, so the per-subject memory cap has enough
  // subjects to actually crowd each other out.
  const allHands = await chat({ type: 'group', name: 'All Hands', createdBy: id.carol });
  await members(allHands, [id.alice, id.bob, id.carol, id.dana, ...range(0, 20)], id.carol);

  // 5. A restricted room most of the workspace cannot even see.
  const board = await chat({
    type: 'group', name: 'Board', createdBy: id.alice, clearanceId: byKey.restricted.id });
  await members(board, [id.alice, at(0), at(17), at(34)], id.alice);

  // 6-13. Ordinary teams, so the list is not entirely edge cases.
  const teams = [
    ['Engineering', byKey.internal.id, range(0, 9)],
    ['Design', null, range(9, 15)],
    ['Contracts', byKey.confidential.id, range(15, 21)],
    ['Support', null, range(21, 29)],
    ['Data', byKey.internal.id, range(29, 35)],
    ['Onboarding', null, range(35, 41)],
    ['Compliance', byKey.confidential.id, range(41, 46)],
    ['Reading Group', null, range(46, 50)],
  ];
  for (const [name, clearanceId, group] of teams) {
    const cid = await chat({ type: 'group', name, createdBy: group[0], clearanceId });
    await members(cid, group, group[0]);
    await say(cid, group[0], `Setting up ${name}.`);
  }

  // 14. A pending join request, so the approve flow has something to show.
  const eng = (await db.from('chats').select('id').eq('name', 'Engineering').single()).data.id;
  await db.from('chat_members').upsert(
    { chat_id: eng, user_id: id.carol, role: 'member', status: 'requested' },
    { onConflict: 'chat_id,user_id' });

  // 15. DMs — never discoverable by anyone else.
  const dm = await chat({ type: 'dm', name: null, createdBy: id.alice });
  await members(dm, [id.alice, id.carol], null);
  for (let i = 0; i < 6; i++) {
    const pair = await chat({ type: 'dm', name: null, createdBy: at(i) });
    await members(pair, [at(i), at(i + 7)], null);
    await say(pair, at(i), 'Quick one before standup.');
  }

  // Erin joins nothing: the "a third session sees nothing" control.

  await say(watercooler, id.alice, 'Morning. Anyone else fighting the coffee machine?');
  await say(watercooler, id.bob, 'It has won again.');
  await say(dealRoom, id.alice, 'Draft terms are in. Governing law is still open.');
  await say(legalOps, id.alice, 'Dana is on the roster but not cleared yet.');
  await say(allHands, id.carol, 'Welcome everybody.');
  await say(board, id.alice, 'Q3 numbers ahead of the meeting.');
  await say(dm, id.alice, 'Quick one, just between us.');

  console.log(`
  ${USERS.length} people, ${teams.length + 6} groups, 7 DMs.

  Worth clicking, in this order:
    alice  restricted    sees everything, admin of most rooms
    bob    confidential  in Deal Room AND Watercooler with an identical member
                         set — the pair the clearance floor exists for
    dana   none          a full member of Legal Ops who can read none of it
    carol  internal      has a pending request to join Engineering
    erin   general       in nothing at all — the "sees nothing" control

  Sign in at /auth/dev?user=alice   (needs ALLOW_DEV_LOGIN=true)
`);
}

main().catch((err) => {
  console.error(`\nseed failed: ${err.message}\n`);
  process.exit(1);
});
