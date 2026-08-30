import { z } from 'zod';
import { TOOLS } from '@/config';
import type { Tool, ToolResult } from './types';

/**
 * File tools.
 *
 * `file_list` is TRUSTED: it returns metadata this system generated — names,
 * sizes, ids. `file_read` is UNTRUSTED: the bytes were chosen by whoever
 * uploaded the document, which may be someone outside this workspace who sent
 * it to a member.
 *
 * Neither is externally observable. Reading our own storage leaks nothing to an
 * outside observer, which is why reading a file does not itself close the
 * D-022 trapdoor for *non-observable* tools — only for ones that could carry
 * data out.
 */

export const fileList: Tool<Record<string, never>> = {
  name: 'file_list',
  description:
    'List the files attached to this conversation, with their ids, names and sizes. ' +
    'Use this to find a file id before reading one.',
  inputSchema: z.object({}).strict(),
  externallyObservable: false,
  returnsUntrustedContent: false,

  async execute(_input, ctx): Promise<ToolResult> {
    const files = await ctx.listFiles();
    if (files.length === 0) {
      return { content: 'No files are attached to this conversation.', citations: [] };
    }

    const lines = files.map(
      (f) => `- ${f.filename} (id: ${f.id}, ${f.mime_type}, ${Math.ceil(f.size_bytes / 1024)} KB)`,
    );

    return {
      content: `${files.length} file(s):\n${lines.join('\n')}`,
      citations: files.map((f) => ({ ref: f.id, label: f.filename })),
      meta: { count: files.length },
    };
  },
};

/** Text-ish types we can extract from without a parsing library. */
const EXTRACTABLE = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html',
  'application/json', 'application/xml', 'text/xml',
]);

export const fileRead: Tool<{ fileId: string }> = {
  name: 'file_read',
  description:
    'Read the text content of a file attached to this conversation. ' +
    'Takes a file id from file_list. Returns the text, truncated if very long.',
  inputSchema: z.object({ fileId: z.string().uuid() }).strict(),
  externallyObservable: false,
  // The bytes were chosen by an uploader, not by us.
  returnsUntrustedContent: true,

  async execute({ fileId }, ctx): Promise<ToolResult> {
    // Scope comes from ctx, not from this id. A file id belonging to another
    // chat resolves to null here regardless of where the id came from.
    const file = await ctx.readFile(fileId);
    if (!file) {
      // Deliberately the same message for "does not exist" and "not in this
      // chat". Distinguishing them would confirm that a file exists elsewhere.
      return { content: 'No such file in this conversation.', citations: [] };
    }

    const { meta, bytes } = file;

    if (bytes.byteLength > TOOLS.perTool.file_read.maxBytes) {
      return {
        content: `The file "${meta.filename}" is too large to read (${Math.ceil(bytes.byteLength / 1024)} KB).`,
        citations: [{ ref: meta.id, label: meta.filename }],
      };
    }

    if (!EXTRACTABLE.has(meta.mime_type)) {
      // Honest refusal rather than decoding bytes as text and producing noise
      // the model would then reason about as if it were content.
      return {
        content:
          `"${meta.filename}" is ${meta.mime_type}, which cannot be read as text. ` +
          `Only plain text, Markdown, CSV, HTML, JSON and XML are supported.`,
        citations: [{ ref: meta.id, label: meta.filename }],
      };
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const extracted = meta.mime_type === 'text/html' ? stripHtml(text) : text;
    const { content, truncated } = truncate(extracted, TOOLS.perTool.file_read.maxBytes / 4);

    return {
      content:
        `"${meta.filename}"${truncated ? ' (truncated)' : ''}:\n\n${content}`,
      citations: [{ ref: meta.id, label: meta.filename }],
      meta: {
        filename: meta.filename, mime_type: meta.mime_type,
        bytes: bytes.byteLength, truncated,
      },
    };
  },
};

/**
 * Crude HTML-to-text. Removes script and style bodies first, because their
 * contents are not prose and a `<script>` block full of URLs is exactly the
 * sort of thing that reads as an instruction once flattened.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncate on a character budget, cutting at a line break where possible. */
export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return {
    content: lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut,
    truncated: true,
  };
}
