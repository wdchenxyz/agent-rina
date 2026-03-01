import { google } from "@ai-sdk/google";
import { generateText, tool } from "ai";
import { z } from "zod";

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
      model: google("gemini-2.5-flash"),
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
      model: google("gemini-2.5-flash"),
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

export const webTools = {
  webSearch,
  fetchWebpage,
};
