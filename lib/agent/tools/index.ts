import { z } from 'zod';
import { KILL_SWITCHES } from '@/config';
import type { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { fileList, fileRead } from './file';
import { documentExtract } from './document';
import { webFetch, searchAvailable } from './web';
import { ToolSession } from './session';
import type { AnyTool } from './types';

export { ToolSession } from './session';
export type { Tool, ToolResult, Citation, AnyTool } from './types';

/**
 * The tool registry.
 *
 * Adding a tool is one file plus one line here. It inherits the authorisation
 * boundary from `ScopedAgentContext`, the bounds from `ToolSession`, and the
 * untrusted-content handling from its own two declared flags — none of which it
 * has to implement or can opt out of.
 *
 * A tool whose dependencies are absent is NOT registered, rather than
 * registered-and-failing. A model will retry a failing tool and burn the
 * per-turn budget doing it; an absent capability it simply works around.
 */
function allTools(): AnyTool[] {
  const tools: AnyTool[] = [
    fileList as AnyTool,
    fileRead as AnyTool,
    documentExtract as AnyTool,
    webFetch as AnyTool,
  ];

  // web_search needs a provider. Registered only when one is configured — see
  // lib/agent/tools/web.ts for why this is not the server-side search tool.
  if (searchAvailable()) {
    // No provider implementation is wired yet; the seam is here so adding one
    // is a single import rather than a change to the loop.
  }

  return tools;
}

/** Open a tool session for one turn. Returns null when tools are switched off. */
export function openToolSession(
  ctx: ScopedAgentContext,
  messageId?: string,
): ToolSession | null {
  if (!KILL_SWITCHES.toolsEnabled) return null;
  const registry = new Map(allTools().map((t) => [t.name, t]));
  return new ToolSession(ctx, registry, messageId);
}

/**
 * Convert a tool to the wire shape the model API expects.
 *
 * This was hand-rolled while there were three tools with one string input
 * between them, and the shortcut it took — *describe every property as a
 * string* — was fine for exactly as long as that held. It stopped holding with
 * `document_extract`, whose `fields` input is an array: the model would have
 * been told to send a string, sent one, and had it rejected by the very schema
 * that had just described it. A wrong tool schema is a silent capability
 * failure, because the model simply appears not to use the tool well.
 *
 * `z.toJSONSchema` ships with Zod 4 and derives it from the same object that
 * validates the input, so the description and the enforcement cannot disagree.
 * `$schema` is stripped: the Anthropic API rejects the meta-schema key.
 */
export function toolDefinition(tool: AnyTool): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  const generated = z.toJSONSchema(tool.inputSchema as z.ZodType, {
    // The model produces INPUT to the schema, so encode/decode differences
    // (defaults, transforms) must be resolved on the input side.
    io: 'input',
    // A tool schema we cannot represent should fail here, loudly, rather than
    // reach the model as `{}` and look like a model that ignores its tools.
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  delete generated.$schema;

  return { name: tool.name, description: tool.description, input_schema: generated };
}
