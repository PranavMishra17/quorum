import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MODELS,
  TIERS,
  PURPOSE_TIER,
  CLEARANCES,
  GATE,
  MEMORY,
  estimateCost,
  TOOLS,
  RESEARCH_TOOL,
  type ModelTier,
} from '@/config';

/**
 * The only tests that pass today, and they are not filler.
 *
 * config/models.ts encodes API rules that are easy to get wrong from memory and
 * that fail at RUNTIME rather than at compile time — passing `effort` to a
 * pre-5 model is a 400, and so is passing `budget_tokens` to a 5-family model.
 * A type system cannot catch a tier pointed at the wrong model. These can.
 */

const tierNames = Object.keys(TIERS) as ModelTier[];

describe('model tiers', () => {
  it.each(tierNames)('%s points at a model in the registry', (name) => {
    expect(MODELS[TIERS[name].model]).toBeDefined();
  });

  it.each(tierNames)(
    '%s sets effort if and only if its model accepts it',
    (name) => {
      const tier = TIERS[name];
      const supported = MODELS[tier.model].supportsEffort;
      // Claude 5 family: effort is the depth dial, budget_tokens is a 400.
      // Haiku 4.5: the inverse — effort itself is the 400.
      expect(tier.effort === null).toBe(!supported);
    },
  );

  it.each(tierNames)('%s uses the thinking shape its model accepts', (name) => {
    const tier = TIERS[name];
    if (MODELS[tier.model].supportsEffort) {
      expect(tier.thinking.kind).not.toBe('budget');
    }
  });

  it.each(tierNames)('%s stays within its model output ceiling', (name) => {
    const tier = TIERS[name];
    expect(tier.maxTokens).toBeLessThanOrEqual(MODELS[tier.model].maxOutputTokens);
  });

  it.each(tierNames)('%s streams when max_tokens is large', (name) => {
    const tier = TIERS[name];
    // Large non-streaming responses hit the SDK HTTP timeout.
    if (tier.maxTokens > 4_096) expect(tier.stream).toBe(true);
  });

  it('keeps retries low — the supplied key is rate-limited', () => {
    for (const name of tierNames) {
      expect(TIERS[name].maxRetries).toBeLessThanOrEqual(1);
    }
  });
});

describe('call purposes', () => {
  it('every purpose maps to a real tier', () => {
    for (const tier of Object.values(PURPOSE_TIER)) {
      expect(TIERS[tier]).toBeDefined();
    }
  });

  it('the user-facing reply is not on the cheapest tier', () => {
    expect(PURPOSE_TIER.chat_response).not.toBe('reflex');
  });
});

describe('cost estimation', () => {
  it('computes per-million-token pricing', () => {
    // Opus 5: $5/MTok in, $25/MTok out.
    expect(estimateCost('claude-opus-5', 1_000_000, 0)).toBeCloseTo(5.0, 10);
    expect(estimateCost('claude-opus-5', 0, 1_000_000)).toBeCloseTo(25.0, 10);
    expect(estimateCost('claude-opus-5', 500_000, 100_000)).toBeCloseTo(5.0, 10);
  });

  it('is zero for a call that never happened', () => {
    expect(estimateCost('claude-haiku-4-5', 0, 0)).toBe(0);
  });

  it('output always costs more than input', () => {
    for (const m of Object.values(MODELS)) {
      expect(m.pricePerMTokOut).toBeGreaterThan(m.pricePerMTokIn);
    }
  });
});

describe('memory retrieval config', () => {
  it('ranking weights sum to exactly 1', () => {
    const { relevance, recency, speakerPresence } = MEMORY.retrieval.weights;
    expect(relevance + recency + speakerPresence).toBeCloseTo(1.0, 10);
  });

  it('caps a single subject well below the global budget', () => {
    // The point of the per-subject cap: in a 20-person group, one
    // heavily-discussed member must not crowd out the other nineteen.
    expect(MEMORY.retrieval.perSubjectCap * 4).toBeLessThanOrEqual(
      MEMORY.retrieval.globalItemCap,
    );
  });

  it('keeps thresholds inside their valid ranges', () => {
    expect(MEMORY.retrieval.relevanceFloor).toBeGreaterThan(0);
    expect(MEMORY.retrieval.relevanceFloor).toBeLessThan(1);
    expect(MEMORY.extraction.confidenceThreshold).toBeGreaterThan(0);
    expect(MEMORY.extraction.confidenceThreshold).toBeLessThan(1);
  });

  it('defers extraction — it must never run inline in the request path', () => {
    expect(MEMORY.extraction.deferred).toBe(true);
  });
});

describe('gate config', () => {
  it('uses a discrete verdict, never a thresholded confidence score', () => {
    // R5: LLM self-reported confidence is not calibrated well enough to
    // threshold on. A `judgeSpeakThreshold: 0.7` lived here and was theatre.
    expect(GATE.judgeVerdicts).toEqual(['respond', 'silent']);
    expect(GATE).not.toHaveProperty('judgeSpeakThreshold');
  });

  it('fails closed', () => {
    // Failure modes are not symmetric: an over-quiet agent is a mild
    // annoyance, an over-eager one is unusable.
    expect(GATE.onJudgeFailure).toBe('silent');
    expect(GATE.judgeVerdicts).toContain(GATE.onJudgeFailure);
  });
});

describe('tool budgets', () => {
  it('no tool is budgeted for longer than the loop containing it', () => {
    // `research` was set to 180s inside a 60s loop — one of the two numbers
    // was dead code. It is now a separate user-invoked turn type.
    for (const [name, cfg] of Object.entries(TOOLS.perTool)) {
      expect(cfg.timeoutMs, `${name} exceeds the tool-loop wall clock`)
        .toBeLessThanOrEqual(TOOLS.maxWallClockMs);
    }
  });

  it('research finishes before its own model call times out', () => {
    expect(RESEARCH_TOOL.timeoutMs).toBeLessThan(TIERS.reason.timeoutMs);
  });

  it('starts with an empty post-untrusted allowlist — fail closed', () => {
    // Once a turn ingests untrusted tool content it may only call tools on
    // this list. Empty means: no further tool calls at all.
    expect(TOOLS.postUntrustedAllowlist).toEqual([]);
  });
});

describe('the seeded ladder matches config', () => {
  it('0008_seed_clearances.sql agrees with CLEARANCES', () => {
    // Two sources of truth for the same ladder — config/agent.ts drives the
    // application, the migration drives the database. If they drift, the
    // clearance floor compares against levels the app does not believe in, and
    // nothing else in the suite would notice.
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0008_seed_clearances.sql'),
      'utf8',
    );
    const seeded = [...sql.matchAll(/\('([a-z_]+)',\s*'([^']+)',\s*(\d+),/g)].map(
      (m) => ({ key: m[1], name: m[2], level: Number(m[3]) }),
    );
    expect(seeded).toEqual(CLEARANCES.map((c) => ({ key: c.key, name: c.name, level: c.level })));
  });
});

describe('clearance ladder', () => {
  it('has unique keys', () => {
    const keys = CLEARANCES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is strictly ascending — the floor comparison depends on a total order', () => {
    for (let i = 1; i < CLEARANCES.length; i++) {
      expect(CLEARANCES[i].level).toBeGreaterThan(CLEARANCES[i - 1].level);
    }
  });

  it('starts at zero so an ungated chat needs no clearance row', () => {
    expect(CLEARANCES[0].level).toBe(0);
  });
});
