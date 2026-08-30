#!/usr/bin/env node
/**
 * Architectural boundary checks.
 *
 * CLAUDE.md states several rules as non-negotiable. Three of them are the kind
 * that a reviewer enforces by remembering to look — which is to say, not
 * enforced. This script makes them mechanical, and CI runs it before lint.
 *
 * This is the direct answer to "what stops a developer bypassing
 * ScopedAgentContext?" — convention is layer 1, this is what turns layer 1 from
 * a documented wish into a failing build. It is NOT a security boundary on its
 * own; RLS is (see README, "The agent is the dangerous actor").
 *
 *   node scripts/check-boundaries.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['app', 'lib', 'config', 'tests'];
const SCAN_EXT = /\.(ts|tsx|js|mjs)$/;

/** Normalise to forward slashes so the rules read the same on Windows and CI. */
const norm = (p) => relative(ROOT, p).split(sep).join('/');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory not created yet — fine, nothing to check
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
    } else if (SCAN_EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Each rule: a pattern, the files allowed to match it, and why the rule exists.
 * `allow` entries are exact normalised paths or prefixes ending in '/'.
 */
const RULES = [
  {
    id: 'service-role-key',
    // CLAUDE.md non-negotiable #2.
    pattern: /SUPABASE_SECRET_KEY|service_role/,
    allow: ['config/env.ts', 'lib/db/scoped-agent.ts'],
    why:
      'The service-role key bypasses RLS entirely. It may be referenced in ' +
      'exactly one runtime file (lib/db/scoped-agent.ts) plus the env schema.',
  },
  {
    id: 'memory-queries',
    // CLAUDE.md non-negotiable #3.
    pattern: /['"`](memory_items|memory_audience)['"`]/,
    allow: ['lib/memory/', 'tests/memory/'],
    why:
      'One filter path means one place to audit and one place to test. A ' +
      'memory query outside lib/memory/ bypasses the audience + clearance filter.',
  },
  {
    id: 'public-secret',
    // A NEXT_PUBLIC_ prefix compiles the value into the browser bundle.
    pattern: /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE_ROLE|ANTHROPIC|PRIVATE)/,
    allow: [],
    why:
      'NEXT_PUBLIC_ variables are inlined into the client bundle. A secret ' +
      'with that prefix is published to the world.',
  },
];

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = norm(file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);

    for (const rule of RULES) {
      const allowed = rule.allow.some((a) =>
        a.endsWith('/') ? rel.startsWith(a) : rel === a,
      );
      if (allowed) continue;

      lines.forEach((line, i) => {
        // Comments explain the rules; they are not violations of them.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (rule.pattern.test(code)) {
          violations.push({ rule, file: rel, line: i + 1, text: line.trim() });
        }
      });
    }
  }
}

if (violations.length === 0) {
  console.log('✓ architectural boundaries intact');
  process.exit(0);
}

console.error(`\n✗ ${violations.length} boundary violation(s)\n`);
const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule.id)) byRule.set(v.rule.id, []);
  byRule.get(v.rule.id).push(v);
}
for (const [id, vs] of byRule) {
  console.error(`  [${id}] ${vs[0].rule.why}`);
  for (const v of vs) console.error(`    ${v.file}:${v.line}  ${v.text}`);
  console.error('');
}
process.exit(1);
