import { z } from 'zod';
import { KILL_SWITCHES } from '@/config';
import type { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { fileList, fileRead } from './file';
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
  const tools: AnyTool[] = [fileList as AnyTool, fileRead as AnyTool, webFetch as AnyTool];

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
 * `zod-to-json-schema` is not a dependency, so schemas are described by hand
 * here. That is a deliberate trade at this size: three tools with small inputs,
 * versus a dependency whose output would still need reviewing. If the tool count
 * grows past a handful, generate them.
 */
export function toolDefinition(tool: AnyTool): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: describeSchema(tool.inputSchema as z.ZodType),
  };
}

function describeSchema(schema: z.ZodType): Record<string, unknown> {
  const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return { type: 'object', properties: {}, additionalProperties: false };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    properties[key] = { type: 'string' };
    if (!field.safeParse(undefined).success) required.push(key);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}
