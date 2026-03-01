import { google } from "@ai-sdk/google";
import {
  createBashTool,
  experimental_createSkillTool as createSkillTool,
} from "bash-tool";
import { ToolLoopAgent, stepCountIs, tool, generateText } from "ai";
import { z } from "zod";
import { resolve } from "path";
import { anthropic } from "@ai-sdk/anthropic";
import { arxivTools } from "./tools/arxiv.mts";

const SYSTEM_PROMPT = `You are a capable AI agent that can search the web, read webpages, execute bash commands in a sandbox, load skills, and research arxiv papers.

Guidelines:
- Use webSearch to find current information on the web.
- Use fetchWebpage when you need to read the content of a specific URL.
- Use bash to explore files, run commands, and process data in the sandbox.
- Use readFile/writeFile for direct file access in the sandbox.
- Use skill to load specialized instructions when a task matches an available skill.
- For arxiv papers: use downloadArxivSource to get LaTeX source, listPaperFiles to see contents, and readPaperFile to read individual files.
- Be concise and direct in your responses.`;

// Web search tool: internally calls Gemini with google_search grounding
const webSearch = tool({
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
          .map((s) => ({ url: s.url, title: "title" in s ? s.title : "" })) ??
        [],
    };
  },
});

// Fetch webpage tool: internally calls Gemini with url_context grounding
const fetchWebpage = tool({
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

async function main() {
  const prompt = process.argv.slice(2).join(" ");
  if (!prompt) {
    console.error("Usage: pnpm agent <prompt>");
    process.exit(1);
  }

  // Set up skills from .agents/skills/
  const skillsDir = resolve(process.cwd(), ".agents/skills");
  const { skill, skills, files: skillFiles, instructions: skillInstructions } =
    await createSkillTool({ skillsDirectory: skillsDir });

  console.error(`[skills] Loaded ${skills.length} skill(s):`);
  for (const s of skills) {
    console.error(`  - ${s.name}: ${s.description.trim().slice(0, 80)}`);
  }

  console.log(`[skills] ${skillInstructions}`);

  // Set up bash sandbox with project files (reads from disk, writes in memory)
  const { tools: bashTools } = await createBashTool({
    uploadDirectory: {
      source: ".",
      include: "**/*.{ts,tsx,js,json,md,yaml,yml}",
    },
    files: skillFiles,
    extraInstructions: skillInstructions,
  });

  // Build the agent
  const agent = new ToolLoopAgent({
    model: anthropic('claude-sonnet-4-6'),
    instructions: SYSTEM_PROMPT,
    tools: {
      ...bashTools,
      ...arxivTools,
      skill,
      webSearch,
      fetchWebpage,
    },
    stopWhen: stepCountIs(20),
    onStepFinish({ toolCalls }) {
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          console.error(
            `[tool] ${tc.toolName}(${JSON.stringify(tc.input).slice(0, 120)})`
          );
        }
      }
    },
  });

  // Run
  const result = await agent.generate({ prompt });
  console.log(result.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
