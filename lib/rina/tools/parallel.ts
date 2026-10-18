import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "ai";
import { z } from "zod";

import { toolResult, toolResultToModelText, type RinaToolResult } from "./results";
import { assertSafePublicUrl } from "./safe-fetch";

const MCP_URL = "https://search.parallel.ai/mcp";
const USER_AGENT = "agent-rina/0.1.0 (+https://github.com/wdchenxyz/agent-rina)";
const TIMEOUT_MS = 45_000;
const sourcesSchema = z.object({
  results: z.array(z.object({
    url: z.string().url(),
    title: z.string().nullish(),
  })).optional(),
  errors: z.array(z.unknown()).optional(),
});

async function callParallel(
  name: "web_search" | "web_fetch",
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<RinaToolResult> {
  const started = Date.now();
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
  const client = new Client({ name: "agent-rina", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "User-Agent": USER_AGENT } },
    // Bound initialization and discovery as well as the tool call. The SDK also
    // supplies a signal for transport shutdown; neither should be discarded.
    fetch: (url, init) => fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    }),
  });

  try {
    signal.throwIfAborted();
    await client.connect(transport);
    const { tools } = await client.listTools({}, { signal });
    if (!tools.some((entry) => entry.name === name)) {
      throw new Error(`Parallel Search MCP does not offer ${name}.`);
    }
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }, undefined, { signal }),
    );
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
    // Search/fetch return JSON text today. Keep text output compatible if the
    // server changes its presentation, but expose structured citations when present.
    let citations;
    let hasEvidence = true;
    try {
      const sources = sourcesSchema.safeParse(JSON.parse(text));
      if (sources.success) {
        const { results, errors } = sources.data;
        citations = results?.map(({ url, title }) => ({ url, title: title ?? undefined }));
        if (results !== undefined) hasEvidence = results.length > 0;
        else if (errors?.length) hasEvidence = false;
      }
    } catch {
      // Plain-text results still carry their source URLs in the excerpts.
    }

    // Preserve the server's excerpts and source URLs for the outer agent to
    // synthesize. There is no second model call and no unsourced fallback.
    return toolResult({
      ok: !result.isError && hasEvidence && text.trim().length > 0,
      summary: text || "Parallel Search MCP returned no text.",
      citations,
      metrics: { elapsedMs: Date.now() - started },
    });
  } catch (error) {
    // Let the agent's cancellation propagate, rather than turning it into a
    // recoverable search error and allowing the loop to keep running.
    if (abortSignal?.aborted) throw abortSignal.reason;
    return toolResult({
      ok: false,
      summary: deadline.aborted
        ? "Parallel Search MCP timed out after 45 seconds."
        : `Parallel Search MCP failed: ${error instanceof Error ? error.message : String(error)}`,
      metrics: { elapsedMs: Date.now() - started },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

const toModelOutput = ({ output }: { output: RinaToolResult }) => ({
  type: "text" as const,
  value: toolResultToModelText(output),
});

export function createParallelTools() {
  const search = tool<{ query: string }, RinaToolResult>({
    description:
      "Search the web using Parallel Search MCP for current information and source excerpts with URLs. Synthesize an answer from the returned evidence and cite its sources.",
    inputSchema: z.object({ query: z.string().trim().min(1).describe("The research question or search query") }),
    execute: ({ query }, { abortSignal }) => callParallel("web_search", {
      objective: query,
      search_queries: [query],
    }, abortSignal),
    toModelOutput,
  });

  return {
    researchWeb: search,
    webSearch: search,
    fetchWebpage: tool<{ url: string; question?: string }, RinaToolResult>({
      description:
        "Read a public webpage using Parallel Search MCP. Returns source excerpts for you to summarize or answer a question, rather than a prewritten answer.",
      inputSchema: z.object({
        url: z.string().url().describe("The public HTTP or HTTPS URL to read"),
        question: z.string().optional().describe("Optional question to focus the excerpts on"),
      }),
      execute: async ({ url, question }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        await assertSafePublicUrl(new URL(url));
        abortSignal?.throwIfAborted();
        return callParallel("web_fetch", {
          urls: [url],
          ...(question && { objective: question.slice(0, 200) }),
        }, abortSignal);
      },
      toModelOutput,
    }),
  };
}
