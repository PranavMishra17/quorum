import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, type Inline, type Block } from '@/lib/ui/markdown';

/**
 * The Markdown subset.
 *
 * Half of these are formatting tests and half are security tests, and the
 * security half is the reason this module exists rather than a dependency:
 * every mainstream Markdown renderer ends at an HTML string, and an HTML string
 * eventually meets `dangerouslySetInnerHTML`. This parser emits a typed tree
 * with no raw-HTML node and no image node, so neither is reachable.
 */

const kinds = (nodes: Inline[]) => nodes.map((n) => n.kind);
const first = (src: string): Block => parseMarkdown(src)[0];

describe('what the agent actually writes', () => {
  it('renders **bold** as a strong node, not literal asterisks', () => {
    const nodes = parseInline('a **bold** word');
    expect(kinds(nodes)).toEqual(['text', 'strong', 'text']);
    expect(nodes[1]).toMatchObject({ kind: 'strong' });
  });

  it('renders a bullet list', () => {
    const block = first('- one\n- two\n- three');
    expect(block.kind).toBe('list');
    if (block.kind !== 'list') return;
    expect(block.ordered).toBe(false);
    expect(block.items).toHaveLength(3);
  });

  it('renders a numbered list as ordered', () => {
    const block = first('1. first\n2. second');
    expect(block.kind).toBe('list');
    if (block.kind !== 'list') return;
    expect(block.ordered).toBe(true);
    expect(block.items).toHaveLength(2);
  });

  it('renders headings up to level 3', () => {
    expect(first('## Parties').kind).toBe('heading');
    // Four hashes is not a heading in this subset, so it stays text rather than
    // silently becoming an h3.
    expect(first('#### too deep').kind).toBe('paragraph');
  });

  it('keeps a fenced code block literal — no inline parsing inside', () => {
    const block = first('```\nconst x = **not bold**;\n```');
    expect(block.kind).toBe('code');
    if (block.kind !== 'code') return;
    expect(block.text).toBe('const x = **not bold**;');
  });

  it('treats backticks as higher precedence than emphasis', () => {
    const nodes = parseInline('use `**literal**` here');
    expect(kinds(nodes)).toEqual(['text', 'code', 'text']);
    expect(nodes[1]).toMatchObject({ kind: 'code', text: '**literal**' });
  });

  it('preserves the line breaks a chat author typed', () => {
    // A document renderer would reflow these into one line. A chat message's
    // line breaks are the author's, and losing them loses their shape.
    const block = first('line one\nline two');
    expect(block.kind).toBe('paragraph');
    if (block.kind !== 'paragraph') return;
    expect(block.lines).toHaveLength(2);
  });

  it('renders a blockquote', () => {
    expect(first('> quoted').kind).toBe('quote');
  });

  it('leaves ordinary prose as a single paragraph', () => {
    const blocks = parseMarkdown('Just a normal sentence.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('paragraph');
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of ['', '```', '**', '[', '](', '- ', '#', '>', '*_`~']) {
      expect(() => parseMarkdown(junk), JSON.stringify(junk)).not.toThrow();
    }
  });
});

/**
 * The half that matters. Message content is written by another user, or quoted
 * from a document the agent read.
 */
describe('markdown cannot become a fetch or a script', () => {
  it('IMAGES ARE DOWNGRADED TO LINKS — the beacon this whole module guards', () => {
    // An <img> fetches when the page renders, handing the URL's host a hit for
    // every reader with no click. A link fetches nothing until chosen.
    const nodes = parseInline('![tracker](https://evil.example/pixel.png)');
    expect(kinds(nodes)).toEqual(['link']);
    expect(nodes[0]).toMatchObject({ kind: 'link', href: 'https://evil.example/pixel.png' });
  });

  it('emits no node type that could render an image, ever', () => {
    const blocks = parseMarkdown('![a](https://x.example/p.png)\n\n<img src="https://y.example/q.png">');
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('"image"');
    expect(json).not.toContain('"html"');
  });

  it('treats raw HTML as text, so a script tag is prose', () => {
    const nodes = parseInline('<script>alert(1)</script>');
    expect(kinds(nodes)).toEqual(['text']);
    expect(nodes[0]).toMatchObject({ text: '<script>alert(1)</script>' });
  });

  it('refuses a javascript: link and shows its source instead', () => {
    const nodes = parseInline('[click me](javascript:alert(1))');
    // Asserting "no link node" rather than an exact node count: how the
    // leftover text happens to be split is an implementation detail, but
    // whether anything became clickable is the actual security property.
    expect(nodes.every((n) => n.kind !== 'link')).toBe(true);
    expect(nodes.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toContain('javascript:');
  });

  it.each([
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('refuses a %s link', (scheme) => {
    const nodes = parseInline(`[x](${scheme})`);
    expect(nodes.every((n) => n.kind !== 'link')).toBe(true);
  });

  it('allows ordinary http and https links', () => {
    const nodes = parseInline('[docs](https://example.com/a)');
    expect(nodes[0]).toMatchObject({ kind: 'link', href: 'https://example.com/a', label: 'docs' });
  });

  it('linkifies a bare URL without swallowing the prose after it', () => {
    const nodes = parseInline('see https://example.com now');
    expect(kinds(nodes)).toEqual(['text', 'link', 'text']);
    expect(nodes[2]).toMatchObject({ text: ' now' });
  });

  it('an empty link label falls back to the URL rather than rendering nothing', () => {
    expect(parseInline('[](https://example.com/x)')[0]).toMatchObject({
      kind: 'link',
      label: 'https://example.com/x',
    });
  });
});
