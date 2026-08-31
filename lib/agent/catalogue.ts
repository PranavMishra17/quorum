import { CONNECTORS, RESEARCH_TOOL, TOOLS } from '@/config';

/**
 * What Quorum can do, described for a person rather than for a model.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT DERIVED FROM THE TOOL REGISTRY
 *
 * The obvious move is to render `allTools()` and read each tool's `description`.
 * That would drift the wrong way: those strings are written FOR THE MODEL — they
 * say when to call something, not what it costs the person whose data it
 * touches. `file_read`'s description tells the model which formats it handles;
 * what a user needs to know is that reading a document closes the turn to
 * outward-facing tools for the rest of that turn.
 *
 * So this is a hand-written catalogue, and the risk it carries is drift: a tool
 * added to the registry and not added here is invisible on this page.
 * `tests/ui/catalogue.test.ts` asserts the two lists agree, which is the only
 * reason a second list is acceptable at all.
 *
 * The `cost` field is the point of the page. Every capability here takes
 * something in exchange — a trapdoor closing, memory being downgraded, results
 * reaching everyone in the room — and a capabilities page that lists only what
 * a product can do is marketing.
 */

export interface Capability {
  /** Registry name, or null for something that is not a tool. */
  tool: string | null;
  title: string;
  what: string;
  /** What it costs, in the user's terms. Never empty. */
  cost: string;
  limit: string;
  /** How it becomes available, when it is not always on. */
  requires?: string;
  group: 'documents' | 'web' | 'connectors' | 'depth';
}

export const CAPABILITIES: readonly Capability[] = [
  {
    tool: 'file_list',
    title: 'See what is attached',
    what: 'Lists the documents attached to the conversation, with their names, types and sizes.',
    cost: 'Nothing. This is metadata the workspace generated, not content anybody wrote.',
    limit: 'Only this conversation. A file attached elsewhere does not appear, whoever uploaded it.',
    group: 'documents',
  },
  {
    tool: 'file_read',
    title: 'Read a document',
    what:
      'Reads an attached file as text — plain text, Markdown, CSV, HTML, JSON, XML, PDF and Word (.docx).',
    cost:
      'The turn is closed to outward-facing tools from that moment on, and anything learned in it can only become a provisional memory, never a confirmed one. A document is text somebody outside this workspace may have written.',
    limit: `Up to ${Math.round(TOOLS.perTool.file_read.maxBytes / 1_000_000)} MB, and the first 40 pages of a PDF. A scan with no text layer is refused with a reason rather than returned as an empty document.`,
    group: 'documents',
  },
  {
    tool: 'document_extract',
    title: 'Pull named fields out of a contract',
    what:
      'Ask for the parties, the effective date, the governing law, a notice period — anything you can name — and get one answer per field with the sentence it came from.',
    cost:
      'Same as reading: the turn is downgraded. It also costs a model call of its own, which appears on your Usage page.',
    limit: `Up to ${12} fields at once. Every quote is checked against the document, and an answer whose quote cannot be found is marked UNVERIFIED rather than quietly dropped.`,
    group: 'documents',
  },
  {
    tool: 'web_fetch',
    title: 'Read a web page',
    what: 'Fetches a URL you give it and reads the text.',
    cost:
      'The request is visible to whoever runs that site, and the URL is written by the agent — so it happens before anything untrusted has been read, never after.',
    limit:
      'Public addresses only. Private networks, loopback and cloud metadata endpoints are refused, so a crafted link cannot make the agent read something inside our own network.',
    group: 'web',
  },
  {
    tool: null,
    title: 'Search the web',
    what: 'Not available. There is no search provider configured on this deployment.',
    cost: '—',
    limit:
      'The seam exists in the code; the tool is simply not registered without a provider, so the agent is never offered something it cannot use.',
    group: 'web',
  },
  {
    tool: 'email_search',
    title: 'Search your own email',
    what:
      'Searches the Gmail account you connected and returns senders, recipients, subjects, dates and a short preview.',
    cost:
      'Results reach everyone in the room. A mailbox has one owner and no notion of who else is present, so this is offered only in direct messages and agent chats — never in a group.',
    limit: `Headers and previews, never full message bodies. ${CONNECTORS.email.maxResults} messages per search. It cannot send, reply to, or change anything.`,
    requires: 'Connect a Google account below.',
    group: 'connectors',
  },
  {
    tool: 'calendar_list',
    title: 'Look at your calendar',
    what: 'Lists events on your primary calendar between two dates, with titles, times and locations.',
    cost: 'Same as email: results are visible to everyone in the room, so it is limited to direct messages.',
    limit: `Attendees are counted, never named — other people did not agree to appear here. Windows up to ${CONNECTORS.calendar.maxWindowDays} days.`,
    requires: 'Connect a Google account below.',
    group: 'connectors',
  },
  {
    tool: null,
    title: 'Research something properly',
    what:
      'Type /research followed by a question. The agent reads what is attached, works in several steps, and cites what it used.',
    cost:
      'Slower and more expensive than an ordinary reply, and it skips the usual "should I speak?" check because you asked directly.',
    limit: `Up to ${RESEARCH_TOOL.maxSteps} steps and ${Math.round(RESEARCH_TOOL.timeoutMs / 1000)} seconds. Once it reads a document it can no longer fetch a page, like any other turn — the rule has no exception for research.`,
    group: 'depth',
  },
] as const;

export const CAPABILITY_GROUPS: Record<Capability['group'], { title: string; blurb: string }> = {
  documents: {
    title: 'Documents',
    blurb:
      'Attach a file to any conversation and the agent finds it on its own — there is no need to tell it the file exists.',
  },
  web: {
    title: 'The web',
    blurb: 'Only what you point it at, and only before it has read anything untrusted.',
  },
  connectors: {
    title: 'Your accounts',
    blurb:
      'Read-only, connected per person, and usable only in a turn you started. Connecting your mail does not let the agent read it on anyone else’s behalf.',
  },
  depth: {
    title: 'Working at length',
    blurb: 'For questions that need more than one look.',
  },
};
