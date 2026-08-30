import { describe, it, expect } from 'vitest';
import {
  MODELS,
  TIERS,
  PURPOSE_TIER,
  CLEARANCES,
  GATE,
  MEMORY,
  estimateCost,
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
    const { similarity, recency, speakerPresence } = MEMORY.retrieval.weights;
    expect(similarity + recency + speakerPresence).toBeCloseTo(1.0, 10);
  });

  it('caps a single subject well below the global budget', () => {
    // The point of the per-subject cap: in a 20-person group, one
    // heavily-discussed member must not crowd out the other nineteen.
    expect(MEMORY.retrieval.perSubjectCap * 4).toBeLessThanOrEqual(
      MEMORY.retrieval.globalItemCap,
    );
  });

  it('keeps thresholds inside their valid ranges', () => {
    expect(MEMORY.retrieval.similarityFloor).toBeGreaterThan(0);
    expect(MEMORY.retrieval.similarityFloor).toBeLessThan(1);
    expect(MEMORY.extraction.confidenceThreshold).toBeGreaterThan(0);
    expect(MEMORY.extraction.confidenceThreshold).toBeLessThan(1);
  });

  it('defers extraction — it must never run inline in the request path', () => {
    expect(MEMORY.extraction.deferred).toBe(true);
  });
});

describe('gate config', () => {
  it('biases toward silence', () => {
    // Failure modes are not symmetric: an over-quiet agent is a mild
    // annoyance, an over-eager one is unusable.
    expect(GATE.judgeSpeakThreshold).toBeGreaterThan(0.5);
    expect(GATE.judgeSpeakThreshold).toBeLessThan(1);
  });

  it('fails closed', () => {
    expect(GATE.onJudgeFailure).toBe('stay_silent');
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
