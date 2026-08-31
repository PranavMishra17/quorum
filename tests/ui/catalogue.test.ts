import { describe, it, expect } from 'vitest';
import { CAPABILITIES, CAPABILITY_GROUPS } from '@/lib/agent/catalogue';
import { allTools } from '@/lib/agent/tools';

/**
 * The Capabilities page is a HAND-WRITTEN list, and this is the test that makes
 * that acceptable.
 *
 * It is not generated from the tool registry on purpose: a tool's `description`
 * is written for the model — when to call it — and users need to know what it
 * costs them. But a second list drifts, and a capabilities page that quietly
 * omits a tool is worse than none, because a reader trusts it to be complete.
 *
 * So: every registered tool must appear here, and nothing here may claim a tool
 * that does not exist.
 */

// Both chat types, so tools registered only in DMs (the connectors) are seen.
const registered = new Set([
  ...allTools('group').map((t) => t.name),
  ...allTools('dm').map((t) => t.name),
]);

const catalogued = new Set(
  CAPABILITIES.map((c) => c.tool).filter((t): t is string => t !== null),
);

describe('the capabilities page cannot drift from the tool registry', () => {
  it('lists every registered tool', () => {
    const missing = [...registered].filter((name) => !catalogued.has(name));
    expect(
      missing,
      'these tools are registered but invisible on the Capabilities page',
    ).toEqual([]);
  });

  it('claims no tool that does not exist', () => {
    // Connector tools are only registered when configured, so they are allowed
    // to be catalogued-but-absent — the page says so, under "requires".
    const optional = new Set(['email_search', 'calendar_list']);
    const phantom = [...catalogued].filter((n) => !registered.has(n) && !optional.has(n));
    expect(phantom, 'the page names a tool the registry does not have').toEqual([]);
  });

  it('found tools at all — the registry read has not silently broken', () => {
    expect(registered.size).toBeGreaterThanOrEqual(4);
  });
});

describe('every entry says what it costs', () => {
  it.each(CAPABILITIES.map((c) => [c.title, c] as const))(
    '%s states a cost and a bound',
    (_title, capability) => {
      // The cost column is the reason the page exists. An entry with a blank
      // one is marketing wearing a table's clothes.
      expect(capability.cost.trim().length).toBeGreaterThan(0);
      expect(capability.limit.trim().length).toBeGreaterThan(0);
      expect(capability.what.trim().length).toBeGreaterThan(0);
    },
  );

  it('every entry belongs to a group that exists', () => {
    for (const c of CAPABILITIES) {
      expect(CAPABILITY_GROUPS[c.group], `${c.title} has no group`).toBeDefined();
    }
  });

  it('names the untrusted-content trapdoor where it applies', () => {
    // file_read and document_extract both close the turn. If that stops being
    // said on this page, a user cannot understand why a later tool refused.
    const reading = CAPABILITIES.filter(
      (c) => c.tool === 'file_read' || c.tool === 'document_extract',
    );
    expect(reading).toHaveLength(2);
    for (const c of reading) {
      expect(c.cost.toLowerCase()).toMatch(/turn is (?:closed|downgraded)|downgraded/);
    }
  });

  it('says the connectors are limited to direct messages', () => {
    for (const name of ['email_search', 'calendar_list']) {
      const entry = CAPABILITIES.find((c) => c.tool === name)!;
      expect(entry.cost.toLowerCase()).toMatch(/direct message/);
    }
  });
});
