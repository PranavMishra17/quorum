import { GATE } from '@/config';
import type { LlmProvider } from '@/lib/llm/provider';
import type { GateDecision, Verdict } from './gate';
import { judgePrompt } from './prompts';

/**
 * The gate judge — consulted only when the deterministic chain falls through.
 *
 * It returns a DISCRETE VERDICT, not a confidence score to threshold.
 *
 * There was a `judgeSpeakThreshold: 0.7` in config, comparing a model-authored
 * float against a constant. LLM self-reported confidence is not calibrated well
 * enough for that to mean anything — it is theatre dressed as rigour. The README
 * had said "a verdict plus a one-line reason" all along; the prose was right and
 * the config was wrong, so the config changed. (D-020)
 *
 * Every failure path resolves to SILENCE. Not because silence is neutral, but
 * because the failure modes are not symmetric: an agent that is quiet slightly
 * too often is a mild annoyance, and one that interjects constantly is unusable.
 * A user who actually wants an answer can always @-mention, which bypasses the
 * judge entirely via rule 3.
 */

export interface JudgeInput {
  /** Most recent messages, oldest first. */
  transcript: { speaker: string; content: string; isAgent: boolean }[];
  chatName: string | null;
  memberCount: number;
}

interface JudgeVerdict {
  verdict: Verdict;
  reason: string;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: [...GATE.judgeVerdicts] },
    reason: {
      type: 'string',
      description: 'One short sentence. Shown to users in the agent internal view.',
      maxLength: 200,
    },
  },
} as const;

function isJudgeVerdict(v: unknown): v is JudgeVerdict {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.verdict === 'string' &&
    (GATE.judgeVerdicts as readonly string[]).includes(o.verdict) &&
    typeof o.reason === 'string' &&
    o.reason.length > 0
  );
}



function renderTranscript(input: JudgeInput): string {
  const header = input.chatName
    ? `Chat "${input.chatName}" with ${input.memberCount} people.`
    : `A chat with ${input.memberCount} people.`;
  const lines = input.transcript.map(
    (m) => `${m.isAgent ? 'assistant' : m.speaker}: ${m.content}`,
  );
  return `${header}\n\nRecent messages:\n${lines.join('\n')}\n\nShould the assistant speak?`;
}

export async function judge(
  provider: LlmProvider,
  input: JudgeInput,
  signal?: AbortSignal,
): Promise<GateDecision> {
  try {
    const result = await provider.structured<JudgeVerdict>({
      purpose: 'gate_judge',
      system: judgePrompt(),
      messages: [{ role: 'user', content: renderTranscript(input) }],
      schema: SCHEMA,
      validate: isJudgeVerdict,
      signal,
    });

    return {
      verdict: result.value.verdict,
      rule: 'judge',
      reason: result.value.reason,
    };
  } catch (err) {
    // Timeout, refusal, malformed output, rate limit, dead key — all of it
    // lands here, and all of it means silence. The reason is recorded so the
    // internal view shows WHY the agent was quiet rather than leaving a gap
    // that looks identical to a considered decision not to speak.
    return {
      verdict: GATE.onJudgeFailure as Verdict,
      rule: 'judge_failed',
      reason: `judge unavailable (${err instanceof Error ? err.name : 'unknown'}); defaulting to silence`,
    };
  }
}
