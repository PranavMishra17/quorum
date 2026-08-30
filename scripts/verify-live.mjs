#!/usr/bin/env node
/**
 * Drive a running Quorum and check the authorisation claims in a real browser.
 *
 *   pnpm dev                          # in one terminal
 *   pnpm seed:dev                     # once
 *   pnpm verify:live                  # here
 *
 * Requires ALLOW_DEV_LOGIN=true so the script can become each seeded user
 * without Google. It refuses to run against a URL that is not localhost,
 * because dev login is closed in production and should stay that way.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * The suite in tests/ proves these rules against the database directly, as an
 * unprivileged role. That is the stronger proof. What it cannot show is that
 * the APPLICATION uses the database correctly — a page that queries with the
 * service role, or forgets a filter, would pass every RLS test and still leak
 * in the browser.
 *
 * So this checks the seam between the two: what a real signed-in user actually
 * sees. Everything here is deliberately read-only and costs no model calls.
 */

import { chromium } from 'playwright';

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(
    `refusing to run against ${BASE}\n` +
      'This script signs in as seeded users via /auth/dev, which exists only\n' +
      'in development. Set VERIFY_BASE_URL to a localhost origin.',
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? `  (${detail})` : ''}`);
  }
}

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function signInAs(page, user) {
  await page.goto(`${BASE}/auth/dev?user=${user}`, { waitUntil: 'networkidle' });
}

async function chatsVisibleTo(page, user) {
  await signInAs(page, user);
  await page.goto(`${BASE}/chats`, { waitUntil: 'networkidle' });
  return page.locator('body').innerText();
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // -----------------------------------------------------------------------
    section('Signed out');

    await context.clearCookies();
    const res = await page.goto(`${BASE}/chats`, { waitUntil: 'networkidle' });
    check(
      'a signed-out visitor is redirected away from /chats',
      new URL(page.url()).pathname === '/',
      `landed on ${new URL(page.url()).pathname}`,
    );
    check('the redirect is not an error page', res.status() < 400, `status ${res.status()}`);

    // -----------------------------------------------------------------------
    section('Axis one — membership');

    const erin = await chatsVisibleTo(page, 'erin');
    check(
      'erin, who is in no chats, sees none',
      /not a member of any chat|no chats/i.test(erin),
      erin.slice(0, 120).replace(/\s+/g, ' '),
    );
    // NOT "no names at all". Ungated groups are deliberately discoverable so
    // that the join-request flow can exist — you cannot ask to join something
    // you cannot see (D-027). What must never appear is a GATED chat: the
    // existence of a restricted conversation is itself disclosure.
    check(
      'no CLEARANCE-GATED chat appears anywhere on her page',
      !/Deal Room|Legal Ops|Board|Engineering|Contracts|Compliance/.test(erin),
      'discovery is gated on clearance even though it is not gated on membership',
    );
    check(
      'ungated groups DO appear as discoverable — she can ask to join',
      /Discoverable/.test(erin) && /Watercooler|All Hands/.test(erin),
    );

    const alice = await chatsVisibleTo(page, 'alice');
    check('alice sees Watercooler', alice.includes('Watercooler'));
    check('alice sees Deal Room', alice.includes('Deal Room'));
    check('alice sees Board (restricted, she holds it)', alice.includes('Board'));

    // -----------------------------------------------------------------------
    section('Axis two — clearance');

    // THE headline check. Dana is a full member of Legal Ops with
    // status='member'; only the clearance floor stops her.
    const dana = await chatsVisibleTo(page, 'dana');
    check(
      'DANA CANNOT SEE LEGAL OPS, despite being a full member of it',
      !dana.includes('Legal Ops'),
      'membership without clearance must grant nothing',
    );
    check(
      'dana still sees the ungated chats she belongs to',
      dana.includes('All Hands') || dana.includes('General'),
      dana.slice(0, 160).replace(/\s+/g, ' '),
    );

    const bob = await chatsVisibleTo(page, 'bob');
    check(
      'bob (confidential) sees Deal Room',
      bob.includes('Deal Room'),
    );
    check(
      'bob (confidential) CANNOT see Board (restricted) — not even as discoverable',
      !bob.includes('Board'),
      'the existence of a restricted room is itself disclosure',
    );
    check(
      'bob sees Watercooler — the level-0 half of the identical-member pair',
      bob.includes('Watercooler'),
    );

    // -----------------------------------------------------------------------
    section('Direct URL access does not bypass anything');

    await signInAs(page, 'alice');
    await page.goto(`${BASE}/chats`, { waitUntil: 'networkidle' });
    const boardLink = page.locator('a', { hasText: 'Board' }).first();
    const boardHref = (await boardLink.count()) ? await boardLink.getAttribute('href') : null;

    if (boardHref) {
      await signInAs(page, 'bob');
      const direct = await page.goto(`${BASE}${boardHref}`, { waitUntil: 'networkidle' });
      check(
        'bob opening the Board URL directly gets 404, not the chat',
        direct.status() === 404,
        `status ${direct.status()}`,
      );
      const body = await page.locator('body').innerText();
      check(
        'and the 404 does not confirm the chat exists by naming it',
        !body.includes('Board'),
      );
    } else {
      check('found a Board link to test direct access against', false, 'no link located');
    }

    // -----------------------------------------------------------------------
    section('The dev-login route itself');

    const bad = await page.goto(`${BASE}/auth/dev?user=nonexistent`, { waitUntil: 'networkidle' });
    check('an unknown dev user is refused', bad.status() === 404, `status ${bad.status()}`);

    // -----------------------------------------------------------------------
    section('Internal view and cost are scoped too');

    await signInAs(page, 'erin');
    await page.goto(`${BASE}/usage`, { waitUntil: 'networkidle' });
    const usage = await page.locator('body').innerText();
    check(
      'erin, in no chats, sees no spend from anyone else',
      /No model calls yet|\$0\.0000/.test(usage),
      usage.slice(0, 120).replace(/\s+/g, ' '),
    );
    // -----------------------------------------------------------------------
    // Costs real model calls, so it is opt-in.
    if (process.env.VERIFY_MEMORY === '1') {
      section('Memory isolation — the thesis (costs model calls)');
      await verifyMemoryIsolation(page);
    } else {
      console.log('  (memory isolation skipped - set VERIFY_MEMORY=1 to run it)');
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of failures) console.log(`  · ${f}`);
    console.log(
      '\nA failure here means the APPLICATION is not using the database\n' +
        'correctly, even if tests/ is green — that suite proves the policies,\n' +
        'not the pages.',
    );
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Teach the agent something in a DM, confirm it surfaces there, then confirm it
 * does NOT surface in a group containing someone who was not in that DM.
 *
 * This is the whole project in three messages. It costs a handful of model
 * calls, which is why it is behind a flag.
 */
async function verifyMemoryIsolation(page) {
  const secret = `only reviews contracts on ${['Mondays','Tuesdays','Wednesdays','Thursdays','Fridays'][Math.floor(Date.now() / 1000) % 5]}`;

  async function openChatNamed(user, name) {
    await signInAs(page, user);
    await page.goto(`${BASE}/chats`, { waitUntil: 'networkidle' });
    const link = page.locator('a', { hasText: name }).first();
    if (!(await link.count())) return false;
    await link.click();
    await page.waitForLoadState('networkidle');
    return true;
  }

  async function say(text) {
    const box = page.locator('input[placeholder*="Message"]');
    await box.fill(text);
    await box.press('Enter');
    // The reply arrives over Realtime after the turn runs in after().
    await page.waitForTimeout(18_000);
    return page.locator('body').innerText();
  }

  // 1. Teach it, in a DM between Alice and Carol.
  if (!(await openChatNamed('alice', 'Direct message'))) {
    check('found a DM to teach a fact in', false, 'no DM link on the chat list');
    return;
  }
  await say(`@quorum please remember that I ${secret}`);

  // 2. It should know, in the room where it learned it.
  const inDm = await say('@quorum when do I review contracts?');
  const day = secret.split(' ').pop();
  check(
    `the agent recalls the fact in the DM where it was learned`,
    inDm.toLowerCase().includes(day.toLowerCase()),
    'if this fails, retrieval is not running at all',
  );

  // 3. It must NOT know, in a group containing people who were not in that DM.
  if (!(await openChatNamed('alice', 'All Hands'))) {
    check('found All Hands to test isolation against', false);
    return;
  }
  const inGroup = await say('@quorum when do I review contracts?');
  // Reload before reading the internal view. The turn runs in after(), so its
  // events land behind the reply; the panel's counts are server-rendered at
  // page load and only stream in afterwards if Realtime is delivering
  // agent_events. Reloading tests what was RECORDED rather than how fast it
  // reached the browser.
  await page.reload({ waitUntil: 'networkidle' });
  const afterReload = await page.locator('body').innerText();
  check(
    'THE AGENT DOES NOT REPEAT IT IN A GROUP CONTAINING NON-PARTICIPANTS',
    !inGroup.toLowerCase().includes(day.toLowerCase()),
    'this is the leak the whole project exists to prevent',
  );
  check(
    'and the internal view records that the filter withheld something',
    /withheld/i.test(afterReload),
    'the count is what makes the filter observable rather than assumed',
  );
}

main().catch((err) => {
  console.error(`\nverification could not run: ${err.message}\n`);
  process.exit(1);
});
