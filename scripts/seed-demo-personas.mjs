#!/usr/bin/env node
/**
 * Create the two demo persona accounts — "Priya" and "Sam" — that every real
 * user's demo world (migration 0020) is built around.
 *
 *   pnpm seed:demo-personas
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ALLOWED TO RUN AGAINST PRODUCTION, UNLIKE seed-dev.mjs
 *
 * `seed-dev.mjs` refuses production on sight, because its ~55 accounts share a
 * published password and exist to let ONE developer become any of several
 * identities without real OAuth — a login bypass, deliberately scoped to
 * development.
 *
 * These two accounts are a different thing: permanent, real, narrowly-scoped
 * fixtures that the live product's own onboarding depends on. They cannot sign
 * in through any UI this app exposes (`/auth/dev` is closed in production by
 * three independent checks, and nothing else accepts a password login for
 * them), they hold no clearance beyond level 0, and `profiles.is_demo = true`
 * excludes them from every ordinary directory, people-picker, and
 * clearance-granting list at the application layer. Their entire capability is
 * "exist as the other party in a per-user demo room" — there is nothing to
 * gain by compromising one that isn't already visible to whoever opens a demo
 * chat.
 *
 * Run this ONCE per environment (local, and again against whatever project the
 * deployed app points at) before the demo world can appear for anyone.
 * `ensure_demo_world()` degrades gracefully — logs a notice and creates
 * nothing — on an environment where this has not been run, so forgetting it
 * never blocks a real sign-in.
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
if (!URL || !SECRET) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required.\n' +
      'Copy .env.example to .env.local and fill it in — see docs/SETUP-SUPABASE.md.',
  );
  process.exit(1);
}

const db = createClient(URL, SECRET, { auth: { persistSession: false } });

/**
 * A random password nobody will ever type. There is no sign-in path for these
 * accounts; the value only has to exist because the Admin API requires one.
 *
 * A SINGLE `randomUUID()` (36 chars), not two concatenated. GoTrue hashes
 * passwords with bcrypt, which silently truncates at 72 bytes — this was an
 * 86-character password that made `createUser` fail with a bare 500 and no
 * indication why, discovered by bisecting a working plain call against this
 * one field at a time. Found the same way `pnpm verify:live` earned its keep
 * earlier in this project: by actually calling the API, not by reading its
 * docs for a length limit that turned out not to be documented at all.
 */
function unusablePassword() {
  return `demo-${crypto.randomUUID()}`;
}

const PERSONAS = [
  { email: 'priya.demo@quorum.dev', name: 'Priya (demo)' },
  { email: 'sam.demo@quorum.dev',   name: 'Sam (demo)' },
];

const PALETTE = [
  '#e06c75', '#d19a66', '#e5c07b', '#98c379',
  '#56b6c2', '#61afef', '#c678dd', '#be5046',
];
function colorFor(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

async function ensurePersona({ email, name }) {
  const { data: existing } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = existing?.users?.find((u) => u.email === email);

  let userId = found?.id;
  if (!userId) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: unusablePassword(),
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (error) throw new Error(`could not create ${email}: ${error.message}`);
    userId = data.user.id;
    console.log(`created auth user  ${email}  (${userId})`);
  } else {
    console.log(`auth user exists   ${email}  (${userId})`);
  }

  const { error: profileError } = await db.from('profiles').upsert(
    { id: userId, display_name: name, color: colorFor(userId), is_demo: true },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(`could not upsert profile for ${email}: ${profileError.message}`);
  console.log(`profile ready       ${name}`);

  return userId;
}

for (const persona of PERSONAS) {
  await ensurePersona(persona);
}

console.log('\nDemo personas ready. New sign-ins will now receive a demo world.');
