import { safeHttpUrl } from './safe-url';

/**
 * A deliberately small Markdown subset, parsed to a typed tree.
 *
 * ---------------------------------------------------------------------------
 * WHY PARSE INSTEAD OF USING A LIBRARY
 *
 * Message content is attacker-controlled — by another user, or by a document
 * the agent read and then quoted. Every mainstream Markdown renderer's happy
 * path ends in an HTML string, and the moment an HTML string exists somebody
 * eventually passes it to `dangerouslySetInnerHTML`. This produces a TREE, and
 * `lib/ui/message-content.tsx` turns that tree into React elements, so the
 * escape hatch never exists in the first place.
 *
 * Two things are structurally impossible here as a result:
 *
 *   - **No raw HTML.** `<img src=x onerror=...>` in a message is text, because
 *     nothing in this file can emit an element the parser did not construct.
 *   - **No auto-fetched resources.** There is no image node. `![alt](url)`
 *     parses to a LINK, not an `<img>` — an image would beacon to the URL's
 *     host the moment anyone opened the chat, with no click required. That is
 *     the exfiltration channel `lib/ui/safe-url.ts` exists to close, and
 *     rendering markdown must not quietly reopen it.
 *
 * Everything the parser does not recognise stays literal text. An unsupported
 * construct rendering as its own source is a good failure; a half-parsed one is
 * not.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; label: string };

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'rule' };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Parse a message body into blocks. Never throws; unknown syntax stays text. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. Everything inside is literal — no inline parsing at all,
    // which is the whole point of a code fence.
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // consume the closing fence, or run off the end harmlessly
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: Inline[][] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        quoted.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block. Its
    // line breaks are KEPT rather than collapsed: chat messages are written
    // with intentional newlines, and reflowing them the way a document renderer
    // would loses the author's shape.
    const paragraph: Inline[][] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === '' ||
        FENCE.test(next) ||
        RULE.test(next) ||
        HEADING.test(next) ||
        QUOTE.test(next) ||
        BULLET.test(next) ||
        ORDERED.test(next)
      ) {
        break;
      }
      paragraph.push(parseInline(next));
      i++;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }

  return blocks;
}

/**
 * Inline spans, in precedence order.
 *
 * Code first, because backticks win over everything — `**not bold**` inside a
 * code span is literal, which is what anyone writing it meant.
 */
const INLINE = new RegExp(
  [
    '(`[^`\\n]+`)', // 1 code
    '(!?\\[[^\\]\\n]*\\]\\([^)\\s]+\\))', // 2 link (or image, downgraded to a link)
    '(\\*\\*[^*\\n]+\\*\\*)', // 3 strong
    '(__[^_\\n]+__)', // 4 strong
    '(\\*[^*\\n]+\\*)', // 5 em
    '(_[^_\\n]+_)', // 6 em
    '(https?://[^\\s<>"\']+)', // 7 bare url
  ].join('|'),
  'g',
);

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    last = at + match[0].length;

    const [, code, link, strongStar, strongUnder, emStar, emUnder, bare] = match;

    if (code) {
      out.push({ kind: 'code', text: code.slice(1, -1) });
    } else if (link) {
      out.push(...parseLink(link));
    } else if (strongStar || strongUnder) {
      const raw = (strongStar ?? strongUnder).slice(2, -2);
      out.push({ kind: 'strong', children: parseInline(raw) });
    } else if (emStar || emUnder) {
      const raw = (emStar ?? emUnder).slice(1, -1);
      out.push({ kind: 'em', children: parseInline(raw) });
    } else if (bare) {
      const href = safeHttpUrl(bare);
      out.push(href ? { kind: 'link', href, label: bare } : { kind: 'text', text: bare });
    }
  }

  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * `[label](url)` — and `![label](url)`, which is Markdown for an image and is
 * deliberately downgraded to a link.
 *
 * An `<img>` fetches its URL when the page renders, with no interaction, which
 * would hand the URL's host a hit for every reader of the chat. A link fetches
 * nothing until someone chooses to click it. That difference is the entire
 * reason this function exists rather than an image node.
 */
function parseLink(raw: string): Inline[] {
  const isImage = raw.startsWith('!');
  const body = isImage ? raw.slice(1) : raw;
  const split = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(body);
  if (!split) return [{ kind: 'text', text: raw }];

  const [, label, target] = split;
  const href = safeHttpUrl(target);
  // An unsafe protocol (javascript:, data:) renders as its own source text, so
  // the reader can see exactly what was in the message.
  if (!href) return [{ kind: 'text', text: raw }];

  return [{ kind: 'link', href, label: label.trim() || target }];
}
