/**
 * Slash commands the composer knows about.
 *
 * `/research` is the only one that exists today (`lib/agent/research.ts`
 * parses it independently — this list is for DISCOVERY, the composer's own
 * popup, and does not enforce anything; the server-side parser is the actual
 * authority on what counts as a command). Kept as a list rather than a single
 * hard-coded row so a second command is one entry, not a new branch of JSX.
 */
export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: '/research',
    usage: '/research <question>',
    description:
      'A longer, multi-step turn: the agent reads attached documents and cites what it used. Skips the "should I speak?" check — you asked directly.',
  },
] as const;

/** Commands whose name starts with what has been typed so far. */
export function matchingCommands(input: string): SlashCommand[] {
  const needle = input.trim().toLowerCase();
  if (!needle.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(needle));
}
