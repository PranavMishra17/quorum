/**
 * The memory-extraction system prompt.
 *
 * Two instructions here are doing real work rather than being politeness.
 *
 * "Returning nothing is normal and correct" — without it, a model given a
 * schema with an array will fill the array. Extraction that invents facts to
 * satisfy a quota is worse than no extraction, because the inventions are
 * indistinguishable from observations once stored.
 *
 * The stated/inferred rule is the one that matters for provenance. A claim by
 * one person ABOUT another is `inferred`, however confidently it is phrased,
 * because the subject has not confirmed it. That distinction is what
 * `conflict.ts` uses to decide which of two contradicting facts survives — so
 * getting it wrong here silently corrupts resolution later.
 *
 * Note what this prompt does NOT do: it does not ask the model to respect
 * privacy or to avoid sensitive topics. Authorisation is not the model's job.
 * Anything extracted is scoped by the audience snapshot taken at write time,
 * whatever the model thought it was recording.
 */
export function extractPrompt(): string {
  return `You extract durable facts about people from a conversation, for an assistant that will use them in future conversations.

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
}
