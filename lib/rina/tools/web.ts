import { execFile } from "child_process";
import { resolve as resolvePath } from "path";
import { google } from "@ai-sdk/google";
import { gateway, generateText, tool } from "ai";
import { z } from "zod";

const AB_SESSION = "rina";
const AB_TIMEOUT_MS = 30_000;
/** Resolve to the project-local agent-browser binary. */
const AB_BIN = resolvePath(process.cwd(), "node_modules/.bin/agent-browser");

/** Run an agent-browser command and return stdout. */
function ab(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      AB_BIN,
      ["--session", AB_SESSION, ...args],
      { timeout: AB_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      }
    );
  });
}

/** Ensure the browser session is closed (best-effort). */
async function abClose() {
  try {
    await ab(["close"]);
  } catch {
    /* session may already be closed */
  }
}

/**
 * Web search tool: internally calls Gemini with google_search grounding.
 * This is a workaround because Gemini does not support mixing custom tools
 * with provider-defined tools in the same call.
 */
export const webSearch = tool({
  description:
    "Search the web for current information. Returns search results with grounded answers.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  execute: async ({ query }) => {
    const { text, sources } = await generateText({
      model: gateway("google/gemini-3.1-flash-lite-preview"),
      tools: { google_search: google.tools.googleSearch({}) },
      prompt: query,
    });
    return {
      text,
      sources:
        sources
          ?.filter((s): s is typeof s & { url: string } => "url" in s)
          .map((s) => ({
            url: s.url,
            title: "title" in s ? (s.title as string) : "",
          })) ?? [],
    };
  },
});

/**
 * Fetch webpage tool: internally calls Gemini with url_context grounding.
 * Same workaround as webSearch — separate Gemini call to avoid mixing
 * provider-defined tools with custom tools.
 */
export const fetchWebpage = tool({
  description:
    "Fetch and read the content of a specific URL. Use this to read articles, docs, or any webpage.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
    question: z
      .string()
      .optional()
      .describe("Optional question to focus the extraction on"),
  }),
  execute: async ({ url, question }) => {
    const prompt = question
      ? `Based on this page: ${url}\n\nAnswer: ${question}`
      : `Read and summarize the content of: ${url}`;
    const { text, sources } = await generateText({
      model: gateway("google/gemini-3.1-flash-lite-preview"),
      tools: { url_context: google.tools.urlContext({}) },
      prompt,
    });
    return {
      text,
      sources:
        sources
          ?.filter((s): s is typeof s & { url: string } => "url" in s)
          .map((s) => ({ url: s.url })) ?? [],
    };
  },
});

/**
 * Perplexity search tool: wraps the AI Gateway's Perplexity search in a locally-
 * executed tool. We use a cheap inner model purely to trigger the gateway-executed
 * search, then extract the raw results from the tool output.
 *
 * This wrapper is necessary because provider-executed gateway tools don't work
 * with the SDK's multi-step loop — the stream ends after the tool result without
 * generating text. By wrapping it in a local execute(), the outer agent's loop
 * continues normally and synthesises a response from the raw search data.
 */
export const perplexitySearch = tool({
  description:
    "Search the web for news, current events, and real-time information. Returns structured search results with excerpts and URLs. Use 'recency' to filter by freshness and 'maxResults' to control how many results to return.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    recency: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe(
        "Filter results by recency. Use 'day' for breaking news, 'week' for recent events, 'month' for recent developments, 'year' for broader context."
      ),
    maxResults: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Maximum number of search results to return (1-20). Use higher values when thoroughness matters."
      ),
  }),
  execute: async ({ query, recency, maxResults }) => {
    try {
      const result = await generateText({
        model: gateway("openai/gpt-5.3-chat"),
        prompt: `Search for: ${query}`,
        tools: {
          perplexity_search: gateway.tools.perplexitySearch({
            ...(recency && { searchRecencyFilter: recency }),
            ...(maxResults && { maxResults }),
          }),
        },
      });

      // Provider-executed tool results store data in `output`, not `result`
      const tr = result.steps[0]?.toolResults?.[0] as
        | { output?: { results?: Array<Record<string, unknown>> } }
        | undefined;
      const raw = tr?.output?.results;

      if (raw?.length) {
        return {
          results: raw.map((r) => ({
            title: (r.title as string) ?? "",
            url: (r.url as string) ?? "",
            snippet: (r.snippet as string) ?? "",
            date: (r.date as string) ?? "",
          })),
        };
      }

      // Fallback: model answered from training data without calling the tool
      if (result.text) {
        return { results: [], text: result.text };
      }

      return { results: [], text: "No search results found." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { results: [], text: `Search failed: ${msg}` };
    }
  },
});

/**
 * Fetch a fully rendered webpage using a headless browser (agent-browser).
 * Handles JS-rendered pages and sites that block simple HTTP requests (403).
 * Falls back gracefully if agent-browser is not available.
 */
export const fetchRenderedPage = tool({
  description:
    "Fetch a fully rendered webpage using a headless browser. Use this when you need raw HTML, visible text, or image URLs from a page. Supports extracting text, HTML, or image URLs.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
    extract: z
      .enum(["text", "html", "images"])
      .optional()
      .describe(
        "What to extract: 'text' for visible page text (default), 'html' for full rendered HTML, 'images' for all image URLs on the page."
      ),
  }),
  execute: async ({ url, extract = "text" }) => {
    try {
      await ab(["open", url]);
      // Use "load" instead of "networkidle" — networkidle hangs on sites with
      // persistent connections (analytics, websockets, long-polling).
      // Add a short extra wait for JS to finish rendering.
      await ab(["wait", "--load", "load"]);
      await ab(["wait", "1500"]);

      const title = await ab(["get", "title"]);
      const finalUrl = await ab(["get", "url"]);

      let content: string;
      switch (extract) {
        case "html":
          content = await ab(["eval", "document.documentElement.outerHTML"]);
          // Truncate to avoid blowing up context
          if (content.length > 100_000) {
            content = content.slice(0, 100_000) + "\n\n[truncated at 100k chars]";
          }
          break;
        case "images":
          content = await ab([
            "eval",
            'JSON.stringify(Array.from(document.querySelectorAll("img")).map(i=>({src:i.src,alt:i.alt||""})).filter(i=>i.src))',
          ]);
          break;
        case "text":
        default:
          content = await ab(["get", "text", "body"]);
          if (content.length > 50_000) {
            content = content.slice(0, 50_000) + "\n\n[truncated at 50k chars]";
          }
          break;
      }

      return { title, url: finalUrl, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to fetch rendered page: ${msg}` };
    } finally {
      await abClose();
    }
  },
});

export const webTools = {
  webSearch,
  fetchWebpage,
  fetchRenderedPage,
  perplexitySearch,
};
