import { parseMarkdown, type Block, type Inline } from '@/lib/ui/markdown';

/**
 * Message rendering — the output-sanitisation boundary.
 *
 * This sits in Phase 1, not with the tools, because the exfiltration channel it
 * closes lives HERE and fires with no agent and no tool involved: if message
 * content produced an `<img>`, an image whose URL carries data would beacon the
 * moment anyone opened the chat. Nobody has to click anything.
 *
 * The rule is therefore not "render text as text" — it is **never emit an
 * element the parser did not construct, and never emit one that fetches**.
 * `lib/ui/markdown.ts` parses to a typed tree with no image node and no raw-HTML
 * node; this file turns that tree into React elements. `dangerouslySetInnerHTML`
 * appears nowhere in this codebase and there is no string of HTML to pass to it.
 *
 * Markdown is rendered because the agent writes it — a reply full of literal
 * `**asterisks**` and `- hyphens` reads as broken, and "the model should stop
 * using Markdown" is a prompt asking for something models do anyway. Rendering
 * a safe subset is the honest fix.
 */
export function MessageContent({ content }: { content: string }) {
  const blocks = parseMarkdown(content);

  return (
    <div className="space-y-2">
      {blocks.map((block, i) => (
        <BlockNode key={i} block={block} />
      ))}
    </div>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const size =
        block.level === 1 ? 'text-[15px]' : block.level === 2 ? 'text-[14px]' : 'text-[13px]';
      return (
        <p className={`${size} font-semibold leading-snug`}>
          <InlineNodes nodes={block.children} />
        </p>
      );
    }

    case 'list':
      return (
        <ul className={`space-y-1 ${block.ordered ? 'list-decimal' : 'list-disc'} pl-5`}>
          {block.items.map((item, i) => (
            <li key={i} className="leading-relaxed">
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ul>
      );

    case 'code':
      // Wide code scrolls inside its own box; the chat column never scrolls
      // sideways because a message was pasted with long lines.
      return (
        <pre className="overflow-x-auto rounded border border-border bg-background/60 p-2 text-[12px] leading-relaxed">
          <code className="font-mono">{block.text}</code>
        </pre>
      );

    case 'quote':
      return (
        <blockquote className="border-l-2 border-border pl-3 text-muted">
          {block.lines.map((line, i) => (
            <span key={i} className="block leading-relaxed">
              <InlineNodes nodes={line} />
            </span>
          ))}
        </blockquote>
      );

    case 'rule':
      return <hr className="border-border" />;

    case 'paragraph':
      return (
        <p className="leading-relaxed">
          {block.lines.map((line, i) => (
            <span key={i} className="block break-words">
              <InlineNodes nodes={line} />
            </span>
          ))}
        </p>
      );
  }
}

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <InlineNode key={i} node={node} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: Inline }) {
  switch (node.kind) {
    case 'text':
      return <>{node.text}</>;
    case 'strong':
      return (
        <strong className="font-semibold">
          <InlineNodes nodes={node.children} />
        </strong>
      );
    case 'em':
      return (
        <em className="italic">
          <InlineNodes nodes={node.children} />
        </em>
      );
    case 'code':
      return (
        <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.9em]">
          {node.text}
        </code>
      );
    case 'link':
      // Inert until clicked, and carrying no referrer or ranking signal. A link
      // the reader chooses to follow is a different risk from a resource the
      // page loads on their behalf.
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-accent underline underline-offset-2"
        >
          {node.label}
        </a>
      );
  }
}
