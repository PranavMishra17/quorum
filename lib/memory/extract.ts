import { MEMORY } from '@/config';
import type { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { logEvent } from '@/lib/events/log';
import type { LlmProvider } from '@/lib/llm/provider';
import { learn, supersede } from './audience';
import { resolve, type Candidate } from './conflict';

/**
 * Deferred memory extraction.
 *
 * Runs AFTER the reply is delivered (D-013). Two reasons: the user-visible turn
 * stays fast, and extraction — which is a second model call — is kept off the
 * critical path where a serverless timeout would take the reply with it.
 *
 * ---------------------------------------------------------------------------
 * MEMORY-WRITE PLANTING (T10) — the failure mode unique to a system that
 * remembers, and the reason `untrustedTurnPolicy` exists.
 *
 * Extraction reads the model's own reply. An injected instruction in a fetched
 * document that makes the model assert a false fact about a user would plant
 * that lie into `memory_items` — correctly authorised, surfacing indefinitely,
 * in every chat the audience rule permits. The generic prompt-injection
 * literature does not cover this, because generic systems do not persist.
 *
 * So anything extracted from a turn that touched untrusted tool content is
 * forced to `inferred` and to `candidate`, regardless of how confidently the
 * model phrased it. Candidates are never retrieved. The item still exists and
 * is still visible in the internal view, so the attempt is auditable rather
 * than merely dropped.
 */

interface ExtractedItem {
  subjectUserId: string;
  content: string;
  sourceType: 'stated' | 'inferred';
  confidence: number;
  volatile: boolean;
  supersedesId: string | null;
}

interface Extraction {
  items: ExtractedItem[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: MEMORY.extraction.maxItemsPerTurn,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subjectUserId', 'content', 'sourceType', 'confidence', 'volatile', 'supersedesId'],
        properties: {
          subjectUserId: { type: 'string', description: 'Must be one of the listed participant ids.' },
          content: { type: 'string', maxLength: 300 },
          sourceType: {
            type: 'string', enum: ['stated', 'inferred'],
            description: '"stated" only when the subject said it about themselves.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          volatile: { type: 'boolean', description: 'True for facts that go stale, e.g. current location or this week\'s task.' },
          supersedesId: {
            type: ['string', 'null'],
            description: 'Id of an existing fact this directly contradicts, or null.',
          },
        },
      },
    },
  },
} as const;

function isExtraction(v: unknown): v is Extraction {
  if (typeof v !== 'object' || v === null) return false;
  const items = (v as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.every((i) => {
    const o = i as Record<string, unknown>;
    return (
      typeof o.subjectUserId === 'string' &&
      typeof o.content === 'string' && o.content.length > 0 &&
      (o.sourceType === 'stated' || o.sourceType === 'inferred') &&
      typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 &&
      typeof o.volatile === 'boolean' &&
      (o.supersedesId === null || typeof o.supersedesId === 'string')
    );
  });
}

const SYSTEM = `You extract durable facts about people from a conversation, for an assistant that will use them in future conversations.

Extract a fact only if it is:
- about a specific named participant
- likely to still be true and still useful weeks from now
- something the assistant would be worse off not knowing

Do NOT extract:
- anything about the assistant itself
- passing moods, jokes, pleasantries, or reactions
- restatements of what was just said, or summaries of the conversation
- anything you are guessing at to fill the quota — returning nothing is normal and correct

Mark sourceType "stated" ONLY when the subject said it about themselves in this
conversation. A claim by one person about another is "inferred", however
confident it sounds, because the subject has not confirmed it.

Mark volatile true for facts with a natural expiry — where someone is this week,
what they are working on right now.

Most turns contain nothing worth keeping. An empty list is the common answer.`;

export interface ExtractParams {
  provider: LlmProvider;
  /** The turn's transcript, oldest first. */
  transcript: { speakerId: string | null; speaker: string; content: string; isAgent: boolean }[];
  /** True if any tool returned untrusted content during this turn. */
  touchedUntrustedContent: boolean;
  originMessageId: string | null;
}

export async function extractMemory(
  ctx: ScopedAgentContext,
  params: ExtractParams,
): Promise<{ written: number; skipped: number }> {
  const startedAt = performance.now();

  try {
    // Re-read membership rather than trusting anything cached. Extraction runs
    // after the reply, so more time has passed than anywhere else in the turn.
    const memberIds = new Set(await ctx.activeMemberIds());
    const names = await ctx.speakerNames();

    if (memberIds.size === 0) {
      return { written: 0, skipped: 0 };
    }

    const roster = [...memberIds]
      .map((id) => `- ${names.get(id) ?? 'Unknown'} (id: ${id})`)
      .join('\n');
    const transcript = params.transcript
      .map((m) => `${m.isAgent ? 'assistant' : m.speaker}: ${m.content}`)
      .join('\n');

    const result = await params.provider.structured<Extraction>({
      purpose: 'memory_extract',
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Participants:\n${roster}\n\nConversation:\n${transcript}\n\nExtract durable facts, or return an empty list.`,
      }],
      schema: SCHEMA,
      validate: isExtraction,
    });

    let written = 0;
    let skipped = 0;

    for (const item of result.value.items.slice(0, MEMORY.extraction.maxItemsPerTurn)) {
      // The model does not get to choose who a fact is about. An id outside the
      // active roster is rejected outright — otherwise a crafted message could
      // plant a fact against a user who is not even in the room, and the
      // audience snapshot would authorise it perfectly.
      if (!memberIds.has(item.subjectUserId)) {
        skipped++;
        continue;
      }

      // T10. Applied AFTER the model has spoken, so no phrasing can evade it.
      const untrusted = params.touchedUntrustedContent;
      const sourceType = untrusted
        ? MEMORY.extraction.untrustedTurnPolicy.forceSourceType
        : item.sourceType;
      const status =
        untrusted || item.confidence < MEMORY.extraction.confidenceThreshold
          ? 'candidate'
          : 'active';

      const expiresAt = item.volatile
        ? new Date(Date.now() + MEMORY.lifecycle.volatileTtlDays * 86_400_000).toISOString()
        : null;

      const id = await learn(ctx, {
        subjectUserId: item.subjectUserId,
        originMessageId: params.originMessageId,
        content: item.content,
        sourceType,
        confidence: item.confidence,
        status,
        expiresAt,
      });

      if (!id) {
        skipped++;
        continue;
      }
      written++;

      await logEvent(ctx, 'memory_written', {
        memory_item_id: id,
        subject_user_id: item.subjectUserId,
        source_type: sourceType,
        status,
        confidence: item.confidence,
        forced_candidate_by_untrusted_content: untrusted,
      });

      if (item.supersedesId) {
        await resolveAgainstExisting(ctx, item, id, sourceType);
      }
    }

    await logEvent(ctx, 'memory_written', {
      summary: true, written, skipped,
      duration_ms: Math.round(performance.now() - startedAt),
    });

    return { written, skipped };
  } catch (err) {
    // Extraction failing must never affect the reply — it has already been
    // delivered. This event IS the durability story for deferred work, and it
    // is stated rather than implied: nothing retries.
    await logEvent(ctx, 'memory_extraction_failed', {
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return { written: 0, skipped: 0 };
  }
}

/** The model nominated a contradiction; `conflict.ts` decides the outcome. */
async function resolveAgainstExisting(
  ctx: ScopedAgentContext,
  item: ExtractedItem,
  newId: string,
  sourceType: 'stated' | 'inferred',
): Promise<void> {
  const { data } = await ctx
    .privilegedClient()
    .from('memory_items')
    .select('id, source_type, created_at, subject_user_id, status')
    .eq('id', item.supersedesId!)
    .maybeSingle();

  const existing = data as {
    id: string; source_type: 'stated' | 'inferred'; created_at: string;
    subject_user_id: string; status: string;
  } | null;

  // Only ever supersede an ACTIVE fact about the SAME person. Without the
  // subject check, the model could retire an arbitrary item by id.
  if (!existing || existing.status !== 'active' || existing.subject_user_id !== item.subjectUserId) {
    return;
  }

  const incoming: Candidate = { id: newId, sourceType, createdAt: new Date() };
  const current: Candidate = {
    id: existing.id,
    sourceType: existing.source_type,
    createdAt: new Date(existing.created_at),
  };

  const resolution = resolve(incoming, current);
  if (resolution.action !== 'supersede') return;

  await supersede(ctx, resolution.supersededId, newId);

  await logEvent(ctx, 'memory_conflict', {
    superseded_id: resolution.supersededId,
    superseded_by: newId,
    incoming_source: sourceType,
    existing_source: existing.source_type,
    // A tie means two directly-stated facts disagreed. The newer wins, but a
    // human should be able to see that something was overwritten.
    genuine_tie: resolution.tie,
  });
}
