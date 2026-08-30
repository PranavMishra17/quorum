import { z } from 'zod';
import { DOCUMENTS, TOOLS } from '@/config';
import { extractDocumentText, isExtractable } from '@/lib/files/extract-text';
import { AnthropicProvider } from '@/lib/llm/anthropic';
import { instrument } from '@/lib/llm/instrumented';
import { documentExtractPrompt } from '@/lib/agent/prompts';
import type { Tool, ToolResult, Citation } from './types';

/**
 * `document_extract` — pull a named set of fields out of a document.
 *
 * The capability a legal workspace actually wants: "who are the parties, what
 * is the term, when does it renew" against a contract, answered as structured
 * data with a supporting quote for each answer rather than as prose the reader
 * has to take on faith.
 *
 * ---------------------------------------------------------------------------
 * A MODEL CALL INSIDE A TOOL CALL
 *
 * This is the only tool that calls the model. Three consequences, all handled
 * here rather than assumed away:
 *
 * 1. **It is accounted for.** The provider is wrapped in `instrument()` with
 *    this turn's context, so the call writes its `llm_calls` row *before* it
 *    goes out, under the same `turn_id` as the reply. A tool that spent money
 *    outside the cost dashboard would make the dashboard a lie.
 *
 * 2. **It is not externally observable.** The document already reaches
 *    Anthropic — every turn sends the conversation there — so this adds no
 *    exfiltration channel that the turn did not already have. That matters
 *    concretely: were it marked observable, D-022 would block it after the
 *    first `file_read`, which is the only situation it is ever used in.
 *
 * 3. **Its output is untrusted.** The values are derived from the document, so
 *    they inherit the document's trust level exactly. The turn is downgraded
 *    and memory extracted from it lands as `candidate` (T10).
 *
 * ---------------------------------------------------------------------------
 * THE QUOTE IS CHECKED, NOT TRUSTED
 *
 * Every quote the model returns is verified as a real substring of the text
 * that was actually sent to it. A citation nobody checks is decoration, and a
 * fabricated quote is *more* dangerous than a fabricated value because it
 * carries the visual grammar of evidence. Findings whose quote does not verify
 * are kept but explicitly marked unverified — dropping them silently would hide
 * that the model was reaching.
 */

const FIELD_PATTERN = /^[\w][\w '(),./-]{0,79}$/;

const inputSchema = z
  .object({
    fileId: z.string().uuid().describe('A file id from file_list.'),
    fields: z
      .array(z.string())
      .min(1)
      .max(DOCUMENTS.maxSchemaFields)
      .describe(
        'The fields to extract, e.g. ["parties", "effective date", "governing law", ' +
          '"termination notice period"]. Short noun phrases work best.',
      ),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface Finding {
  field: string;
  value: string | null;
  quote: string | null;
}

/**
 * NO CONSTRAINT KEYWORDS. Anthropic's structured outputs reject `maxItems`,
 * `minimum`/`maximum` and friends with a 400 that fails the entire call — the
 * bug that silently disabled memory extraction for a whole build. The bounds
 * live in `isFindings` and in the input schema above, where they are enforced
 * rather than requested.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'value', 'quote'],
        properties: {
          field: { type: 'string', description: 'The field, copied from the request.' },
          value: {
            type: ['string', 'null'],
            description: 'What the document says, or null if it does not say.',
          },
          quote: {
            type: ['string', 'null'],
            description: 'A short verbatim substring of the document supporting the value, or null.',
          },
        },
      },
    },
  },
} as const;

function isFindings(v: unknown): v is { findings: Finding[] } {
  if (typeof v !== 'object' || v === null) return false;
  const findings = (v as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return false;
  return findings.every((f) => {
    const o = f as Record<string, unknown>;
    return (
      typeof o.field === 'string' &&
      (o.value === null || typeof o.value === 'string') &&
      (o.quote === null || typeof o.quote === 'string')
    );
  });
}

export const documentExtract: Tool<Input> = {
  name: 'document_extract',
  description:
    'Extract a named set of fields from a document attached to this conversation — ' +
    'for example the parties, effective date, governing law or notice period of a ' +
    'contract. Returns one answer per field with a supporting quote, and says so ' +
    'explicitly when the document does not answer a field. Prefer this over ' +
    'file_read when you want specific facts rather than the whole text.',
  inputSchema,
  externallyObservable: false,
  returnsUntrustedContent: true,

  async execute({ fileId, fields }, ctx): Promise<ToolResult> {
    // Scope comes from ctx. A file id from another chat resolves to nothing,
    // no matter where in the model's context that id came from.
    const file = await ctx.readFile(fileId);
    if (!file) {
      return { content: 'No such file in this conversation.', citations: [] };
    }

    const { meta, bytes } = file;
    const citations: Citation[] = [{ ref: meta.id, label: meta.filename }];

    if (bytes.byteLength > TOOLS.perTool.file_read.maxBytes) {
      return {
        content: `"${meta.filename}" is too large to process.`,
        citations,
      };
    }
    if (!isExtractable(meta.mime_type)) {
      return {
        content: `"${meta.filename}" is ${meta.mime_type}, which cannot be read as text.`,
        citations,
      };
    }

    // Field names are model-authored and are interpolated into a prompt, so
    // they are input. Rejecting the odd ones is cheap; the alternative is that
    // a document can name its own extraction fields by way of the model.
    const requested = fields
      .map((f) => f.trim())
      .filter((f) => FIELD_PATTERN.test(f))
      .slice(0, DOCUMENTS.maxSchemaFields);

    if (requested.length === 0) {
      return { content: 'No usable field names were given.', citations };
    }

    const extraction = await extractDocumentText(
      bytes,
      meta.mime_type,
      DOCUMENTS.maxCharsForSchemaExtraction,
    );
    if (!extraction.ok) {
      return {
        content: `"${meta.filename}" could not be read: ${extraction.reason}.`,
        citations,
        meta: { extraction_failed: extraction.reason },
      };
    }

    const provider = instrument(new AnthropicProvider(), ctx);
    const result = await provider.structured<{ findings: Finding[] }>({
      purpose: 'document_extract',
      system: documentExtractPrompt(),
      messages: [
        {
          role: 'user',
          content:
            `Fields to extract:\n${requested.map((f) => `- ${f}`).join('\n')}\n\n` +
            `Document "${meta.filename}"${extraction.truncated ? ' (truncated)' : ''}:\n\n` +
            extraction.text,
        },
      ],
      schema: SCHEMA,
      validate: isFindings,
    });

    // Only fields we asked for, only once each. A model that answers a field
    // nobody requested is answering something the document suggested.
    const seen = new Set<string>();
    const byField = new Map<string, Finding>();
    for (const finding of result.value.findings) {
      const key = finding.field.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      byField.set(key, finding);
    }

    let verified = 0;
    let unverified = 0;
    let missing = 0;

    const lines = requested.map((field) => {
      const finding = byField.get(field.toLowerCase());
      if (!finding || finding.value === null || finding.value.trim() === '') {
        missing++;
        return `- ${field}: NOT STATED in this document`;
      }

      const quote = finding.quote?.trim();
      const quoteVerified = !!quote && containsQuote(extraction.text, quote);
      if (quoteVerified) {
        verified++;
        citations.push({
          ref: meta.id,
          label: meta.filename,
          locator: quote!.slice(0, 160),
        });
        return `- ${field}: ${finding.value}\n    quoted: "${truncateQuote(quote!)}"`;
      }

      unverified++;
      return (
        `- ${field}: ${finding.value}\n` +
        `    (UNVERIFIED — no supporting quote could be matched in the document)`
      );
    });

    return {
      content:
        `Fields extracted from "${meta.filename}"` +
        `${extraction.truncated ? ' (only part of the document was read)' : ''}:\n\n` +
        `${lines.join('\n')}\n\n` +
        `Report a field as unknown if it is marked NOT STATED, and say a value is ` +
        `unconfirmed if it is marked UNVERIFIED.`,
      citations,
      meta: {
        filename: meta.filename,
        kind: extraction.kind,
        fields_requested: requested.length,
        verified,
        unverified,
        not_stated: missing,
        truncated: extraction.truncated,
      },
    };
  },
};

/**
 * Is this quote genuinely in the document?
 *
 * Whitespace is normalised on both sides before comparing, and only whitespace.
 * PDF extraction reflows lines, so an exact byte match would fail on quotes
 * that ARE real and push the honest answer into the unverified bucket. Anything
 * looser — case folding, punctuation stripping, fuzzy distance — starts
 * accepting quotes the document does not contain, which is the failure this
 * check exists to catch.
 */
export function containsQuote(document: string, quote: string): boolean {
  const flatten = (s: string) => s.replace(/\s+/g, ' ').trim();
  const needle = flatten(quote);
  // A quote of two words is not evidence of anything; it will match by accident.
  if (needle.length < 12) return false;
  return flatten(document).includes(needle);
}

function truncateQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
