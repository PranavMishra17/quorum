import { URL_PATTERN, safeHttpUrl } from '@/lib/ui/safe-url';

/**
 * Message rendering — the output-sanitisation boundary.
 *
 * This sits in Phase 1, not with the tools, because the exfiltration channel it
 * closes lives HERE and fires with no agent and no tool involved. If message
 * content were rendered as markdown or HTML, an image whose URL carries data
 * would beacon the moment anyone opened the chat. Nobody has to click anything.
 *
 * So: text is rendered as text. React escapes it, `dangerouslySetInnerHTML`
 * appears nowhere in this codebase, and no remote resource is ever fetched on
 * behalf of message content.
 *
 * URLs are linkified because a chat without links is annoying, but they are
 * inert until clicked and carry `noopener noreferrer nofollow`. A link the user
 * chooses to follow is a different risk from a resource the page loads for them.
 */
export function MessageContent({ content }: { content: string }) {
  return (
    <>
      {content.split('\n').map((line, lineIndex) => (
        <span key={lineIndex} className="block whitespace-pre-wrap break-words">
          {linkify(line)}
        </span>
      ))}
    </>
  );
}

function linkify(line: string) {
  // split() on a capturing group interleaves text and matches, so odd indices
  // are the candidate URLs.
  return line.split(URL_PATTERN).map((part, i) => {
    if (i % 2 === 0) return part;
    const href = safeHttpUrl(part);
    if (!href) return part;
    return (
      <a
        key={i}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline underline-offset-2"
      >
        {part}
      </a>
    );
  });
}
