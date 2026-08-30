import { z } from 'zod';
import { TOOLS } from '@/config';
import { extractDocumentText, isExtractable } from '@/lib/files/extract-text';
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

export const fileRead: Tool<{ fileId: string }> = {
  name: 'file_read',
  description:
    'Read the text content of a file attached to this conversation — plain text, ' +
    'Markdown, CSV, HTML, JSON, XML, PDF or Word (.docx). Takes a file id from ' +
    'file_list. Long documents are truncated, and you are told when that happens.',
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
    const cite = [{ ref: meta.id, label: meta.filename }];

    if (bytes.byteLength > TOOLS.perTool.file_read.maxBytes) {
      return {
        content: `The file "${meta.filename}" is too large to read (${Math.ceil(bytes.byteLength / 1024)} KB).`,
        citations: cite,
      };
    }

    if (!isExtractable(meta.mime_type)) {
      // Honest refusal rather than decoding bytes as text and producing noise
      // the model would then reason about as if it were content.
      return {
        content:
          `"${meta.filename}" is ${meta.mime_type}, which cannot be read as text. ` +
          `Supported: plain text, Markdown, CSV, HTML, JSON, XML, PDF and Word (.docx).`,
        citations: cite,
      };
    }

    const result = await extractDocumentText(bytes, meta.mime_type);

    if (!result.ok) {
      // A refusal the model can act on — "that PDF is a scan" lets it ask for a
      // text version, where "the tool failed" leaves it guessing.
      return {
        content: `"${meta.filename}" could not be read: ${result.reason}.`,
        citations: cite,
        meta: { filename: meta.filename, mime_type: meta.mime_type, extraction_failed: result.reason },
      };
    }

    const notes = [
      result.truncated ? 'truncated' : null,
      result.note ?? null,
    ].filter(Boolean);

    return {
      content: `"${meta.filename}"${notes.length ? ` (${notes.join('; ')})` : ''}:\n\n${result.text}`,
      citations: cite,
      meta: {
        filename: meta.filename,
        mime_type: meta.mime_type,
        bytes: bytes.byteLength,
        kind: result.kind,
        chars: result.text.length,
        truncated: result.truncated,
        ...(result.pages !== undefined ? { pages: result.pages, pages_read: result.pagesRead } : {}),
      },
    };
  },
};
