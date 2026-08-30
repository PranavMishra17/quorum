import { z } from 'zod';
import { TOOLS, serverEnv } from '@/config';
import { stripHtml, truncate } from '@/lib/files/extract-text';
import { checkUrl } from './url-safety';
import type { Tool, ToolResult } from './types';

/**
 * Web tools.
 *
 * Both are `externallyObservable: true` — the request itself is visible to
 * whoever controls the host, and the URL is model-authored, so it can carry
 * data. That flag is what makes D-022 bite: once this turn has read anything
 * untrusted, neither of these can run again.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE CLIENT-SIDE TOOLS AND NOT THE SERVER-SIDE `web_search` TOOL
 *
 * Anthropic offers `web_search` and `web_fetch` as server-side tools that run
 * inside the model call. They are better implementations than these.
 *
 * They are not used here, and the reason is structural: content they retrieve
 * enters the model's context *without passing through `ToolSession`*. It would
 * never be fenced, the turn would never be marked as having touched untrusted
 * content, and D-022 could not fire — so an injected instruction could reach a
 * second retrieval. The entire injection story in this project depends on
 * untrusted content entering through one door we control.
 *
 * A worse tool inside the boundary beats a better one outside it. Recorded as
 * D-030.
 */

const MAX_RESPONSE_BYTES = 2_000_000;

export const webFetch: Tool<{ url: string }> = {
  name: 'web_fetch',
  description:
    'Fetch a public web page and return its text. Use only for URLs already ' +
    'mentioned in the conversation or returned by web_search.',
  inputSchema: z.object({ url: z.string().min(1).max(2000) }).strict(),
  externallyObservable: true,
  returnsUntrustedContent: true,

  async execute({ url: raw }): Promise<ToolResult> {
    const verdict = checkUrl(raw);
    if (!verdict.ok) {
      return { content: `Cannot fetch that URL: ${verdict.reason}.`, citations: [] };
    }
    const url = verdict.url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOLS.perTool.web_fetch.timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        // Do NOT follow redirects automatically: a public URL can 302 to
        // 169.254.169.254, and the safety check only ever saw the first hop.
        redirect: 'manual',
        headers: { 'User-Agent': 'Quorum/0.1 (+agent fetch)', Accept: 'text/html,text/plain' },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        return {
          content:
            `That URL redirects${location ? ` to ${location}` : ''}. ` +
            `Redirects are not followed automatically; fetch the destination explicitly if it is appropriate.`,
          citations: [{ ref: url.toString(), label: url.hostname }],
        };
      }

      if (!res.ok) {
        return {
          content: `The page returned HTTP ${res.status}.`,
          citations: [{ ref: url.toString(), label: url.hostname }],
        };
      }

      const type = res.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/json|text\/markdown/i.test(type)) {
        return {
          content: `That URL returned ${type || 'an unknown content type'}, which cannot be read as text.`,
          citations: [{ ref: url.toString(), label: url.hostname }],
        };
      }

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) {
        return {
          content: 'That page is too large to read.',
          citations: [{ ref: url.toString(), label: url.hostname }],
        };
      }

      const body = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      const text = /text\/html/i.test(type) ? stripHtml(body) : body;
      const { content, truncated } = truncate(text, TOOLS.perTool.web_fetch.maxContentTokens * 4);

      return {
        content: content || 'The page had no readable text.',
        citations: [{ ref: url.toString(), label: url.hostname }],
        meta: { status: res.status, bytes: buffer.byteLength, truncated },
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        content: aborted ? 'The page took too long to respond.' : 'That page could not be fetched.',
        citations: [],
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Web search.
 *
 * Behind a provider interface because the choice is not settled and should not
 * be load-bearing. Absent a `SEARCH_API_KEY`, the tool is simply not registered
 * — an unavailable capability is better than a tool that always fails, because
 * the model will retry a failing tool and burn the per-turn budget doing it.
 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string, limit: number): Promise<SearchHit[]>;
}

export function searchAvailable(): boolean {
  try {
    return Boolean(serverEnv().SEARCH_API_KEY);
  } catch {
    return false;
  }
}

export function webSearch(provider: SearchProvider): Tool<{ query: string }> {
  return {
    name: 'web_search',
    description:
      'Search the web and return a few results with titles, URLs and snippets. ' +
      'Results are summaries, not full pages — use web_fetch to read one.',
    inputSchema: z.object({ query: z.string().min(2).max(400) }).strict(),
    externallyObservable: true,
    // Snippets are attacker-authored: anyone can publish a page whose snippet
    // contains an instruction.
    returnsUntrustedContent: true,

    async execute({ query }): Promise<ToolResult> {
      const hits = await provider.search(query, TOOLS.perTool.web_search.maxUses);
      if (hits.length === 0) {
        return { content: `No results for "${query}".`, citations: [] };
      }

      // Summarised into context rather than dumped raw: a snippet is a claim by
      // a page, and it is presented as one.
      const lines = hits.map(
        (h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, ' ').slice(0, 300)}`,
      );

      return {
        content: `Results for "${query}":\n\n${lines.join('\n\n')}`,
        citations: hits.map((h) => ({ ref: h.url, label: h.title })),
        meta: { hits: hits.length },
      };
    },
  };
}
