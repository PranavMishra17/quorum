export interface MemoryLine {
  subjectName: string;
  content: string;
  sourceType: 'stated' | 'inferred';
}

export interface ReplyPromptParams {
  chatName: string | null;
  chatType: string;
  memberNames: string[];
  memory: MemoryLine[];
}

/**
 * The memory block.
 *
 * Everything here has already passed the surfacing rule in SQL, so the model is
 * never asked to decide what it may repeat — it cannot leak what it was not
 * given. The instruction below is about TACT, not authorisation, and keeping
 * that straight matters: a prompt asking the model to be discreet would be a
 * mitigation, whereas not sending the item is a control.
 *
 * `stated` and `inferred` are distinguished because they mean different things
 * to a reader — one is what the person said, the other is what was deduced
 * about them — and the agent should not present the second as the first.
 */
export function memorySection(memory: MemoryLine[]): string {
  if (memory.length === 0) return '';

  const lines = memory
    .map(
      (m) =>
        `- ${m.subjectName}: ${m.content}` +
        (m.sourceType === 'inferred' ? ' (inferred, not confirmed by them)' : ''),
    )
    .join('\n');

  return `

What you already know about the people here:
${lines}

Everyone in this conversation is cleared to hear all of the above — it has been
filtered before reaching you. Use it where it helps. Do not recite it, do not
announce that you remember things, and do not bring up something personal just
because you can.`;
}

/**
 * The conversational system prompt.
 *
 * "You have already decided that speaking is appropriate" is deliberate: the
 * gate ran before this call, so a model that deliberates about whether to reply
 * is re-litigating a decision already made — and tends to produce hedging
 * preamble instead of an answer.
 */
export function replyPrompt(params: ReplyPromptParams): string {
  const where = params.chatName
    ? `You are in "${params.chatName}", a ${params.chatType} chat`
    : `You are in a ${params.chatType} chat`;

  return `You are Quorum, an assistant present in every conversation in this workspace.

${where} with ${params.memberNames.length} people: ${params.memberNames.join(', ')}.

You have already decided that speaking is appropriate — that decision is made
before you are called, so do not deliberate about whether to reply. Reply.

How to write here:
- You are one voice among several, not a chat window. Be brief.
- Answer the thing that was actually asked. No preamble, no summarising what
  people just said back to them, no offering further help.
- If you do not know, say so plainly and stop.
- Never claim to have done something you have not done.

You know only what is in this conversation and in the notes below, if any. If
you seem to know something that is in neither, you are wrong — say you are not
sure instead.${memorySection(params.memory)}`;
}
