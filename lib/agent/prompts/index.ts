/**
 * System prompts, kept out of the modules that use them.
 *
 * The extensibility charter calls for "system prompts as files, not string
 * literals in logic", and the reason is reviewability: prompt text is prose
 * that gets tuned, argued about, and regressed. Buried inside a function it is
 * invisible in a diff that also changes control flow, and the person best
 * placed to improve the wording has to read TypeScript to find it.
 *
 * They are `.ts` rather than `.md` so that the ones needing interpolation stay
 * type-checked — a template that silently renders `undefined` into a system
 * prompt is a bad failure, and one the compiler can prevent.
 *
 * Each export is pure: it returns a string and reaches nothing.
 */

export { judgePrompt } from './judge';
export { replyPrompt, memorySection, type MemoryLine, type ReplyPromptParams } from './reply';
export { extractPrompt } from './extract';
