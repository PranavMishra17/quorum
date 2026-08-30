import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE INVARIANT THAT MAKES ScopedAgentContext CAPABILITY-STYLE.
 *
 *   No method accepts a scope-defining id as a parameter.
 *
 * Threading a context object into a function does not, by itself, make a design
 * capability-based — that claim is only true under this invariant. Tool input is
 * transitively model-controlled and therefore injection-influenceable: if any
 * method took a `chatId`, a crafted document could redirect the agent's reads
 * and the context would have degraded into ambient authority with extra steps.
 *
 * This is a source-level check rather than a runtime one because TypeScript
 * parameter names do not survive to runtime, and because the thing worth
 * catching is someone *writing* such a method, not calling one.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'lib', 'db', 'scoped-agent.ts'),
  'utf8',
);

/** Identifiers that name a scope. A method taking one of these widens authority. */
const SCOPE_DEFINING = [
  'chatid', 'chat_id',
  'userid', 'user_id',
  'actorid', 'actor_id',
  'subjectuserid', 'subject_user_id',
  'memberid', 'member_id',
  'ownerid', 'owner_id',
];

/**
 * Method signatures declared on the class body (two-space indent), excluding
 * the constructor and the static factory — construction is exactly where scope
 * is legitimately supplied.
 */
function methodSignatures(): { name: string; params: string }[] {
  const out: { name: string; params: string }[] = [];
  const re = /^ {2}(?:(?:private|public|protected)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SOURCE)) !== null) {
    const [, name, params] = m;
    if (name === 'constructor' || name === 'open' || name === 'if' || name === 'for') continue;
    out.push({ name, params });
  }
  return out;
}

describe('ScopedAgentContext', () => {
  it('exposes methods at all — the parser has not silently stopped matching', () => {
    // Without this, a change to the class shape could make every assertion
    // below vacuously true, which is the same failure mode as the empty-audience
    // trap: a check that passes because it examined nothing.
    const names = methodSignatures().map((s) => s.name);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain('activeMemberIds');
    expect(names).toContain('recentMessages');
    expect(names).toContain('assertActorAuthorised');
  });

  it.each(SCOPE_DEFINING)('no method takes a parameter named like "%s"', (needle) => {
    const offenders = methodSignatures().filter((s) =>
      s.params.toLowerCase().replace(/\s/g, '').includes(needle),
    );
    expect(
      offenders.map((o) => `${o.name}(${o.params})`),
      'a method taking a scope-defining id degrades the context into ambient authority',
    ).toEqual([]);
  });

  it('scope is fixed at construction — chatId is readonly', () => {
    expect(SOURCE).toMatch(/readonly chatId: string/);
    expect(SOURCE).toMatch(/readonly turnId: string/);
    expect(SOURCE).toMatch(/readonly actorId: string/);
  });

  it('does NOT cache membership or clearance — that would be the TOCTOU gap', () => {
    // Both must be methods that hit the database, not fields populated once.
    expect(SOURCE).toMatch(/async activeMemberIds\(\)/);
    expect(SOURCE).toMatch(/async clearanceLevel\(\)/);
    expect(SOURCE).not.toMatch(/readonly (memberIds|members|clearance|clearanceLevel):/);
  });

  it('re-checks authorisation before reads that reach the model', () => {
    // Every read method must call assertActorAuthorised() first.
    for (const method of ['recentMessages', 'listFiles']) {
      const body = SOURCE.slice(SOURCE.indexOf(`async ${method}(`));
      const upToNextMethod = body.slice(0, body.indexOf('\n  async ', 10));
      expect(upToNextMethod, `${method} must re-check authorisation`)
        .toMatch(/await this\.assertActorAuthorised\(\)/);
    }
  });
});

describe('the service-role client cannot be obtained without a scope', () => {
  // Note what is NOT asserted here: that the secret key name appears in this
  // file. `pnpm check:boundaries` owns that rule, and writing the literal into
  // a test would itself trip it — correctly, since the checker cannot tell an
  // assertion from a use. These cover what the checker cannot: the shape that
  // makes the key unreachable.

  it('reads secrets through the validated server env, not process.env directly', () => {
    expect(SOURCE).toMatch(/serverEnv\(\)/);
    // A raw process.env read would sidestep the client/server split in
    // config/env.ts, which is a security boundary and not tidiness.
    expect(SOURCE).not.toMatch(/process\.env\./);
  });

  it('the client factory is module-private, so scope cannot be sidestepped', () => {
    // `function createServiceClient` with no `export` — the only way to obtain
    // a service-role client from outside this file is via a chat-scoped context.
    expect(SOURCE).toMatch(/^function createServiceClient/m);
    expect(SOURCE).not.toMatch(/^export function createServiceClient/m);
  });
});
