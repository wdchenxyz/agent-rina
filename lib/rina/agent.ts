import { anthropic } from "@ai-sdk/anthropic";
import {
  ToolLoopAgent,
  stepCountIs,
  type ModelMessage,
  type UserContent,
  type ToolSet,
} from "ai";
import { resolve } from "path";

import { SYSTEM_PROMPT, TOOL_STATUS } from "./constants";
import { createArtifactTools } from "./tools/artifacts";
import { createArxivTools } from "./tools/arxiv";
import { webTools } from "./tools/web";
import type { BotThread } from "./types";

const MAX_STEPS = 20;
const RETRY_DELAYS_MS = [400, 1200, 2500];
const TELEGRAM_MAX_LENGTH = 4000;

// --- Helpers ---

function splitLongText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MAX_LENGTH) {
    const slice = remaining.slice(0, TELEGRAM_MAX_LENGTH);
    let splitAt = slice.lastIndexOf("\n\n");
    if (splitAt < TELEGRAM_MAX_LENGTH / 2) splitAt = slice.lastIndexOf("\n");
    if (splitAt < TELEGRAM_MAX_LENGTH / 2) splitAt = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim().length > 0) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & {
    code?: string;
    cause?: { code?: string };
    originalError?: { code?: string };
  };
  const message = error.message.toLowerCase();
  return (
    withCode.code === "NETWORK_ERROR" ||
    withCode.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    withCode.originalError?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("network error") ||
    message.includes("connect timeout")
  );
}

async function postWithRetry(
  thread: BotThread,
  content: string,
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await thread.post({ markdown: content });
      return;
    } catch (error) {
      if (
        attempt >= RETRY_DELAYS_MS.length ||
        !isRetryableNetworkError(error)
      ) {
        throw error;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}

// --- Lazy bash/skill tool setup ---

let bashToolsPromise: Promise<Record<string, unknown>> | null = null;

async function loadBashAndSkillTools(): Promise<Record<string, unknown>> {
  // Dynamic import because bash-tool is ESM-only
  const { createBashTool, experimental_createSkillTool: createSkillTool } =
    await import("bash-tool");

  const skillsDir = resolve(process.cwd(), ".agents/skills");
  const {
    skill,
    files: skillFiles,
    instructions: skillInstructions,
  } = await createSkillTool({ skillsDirectory: skillsDir });

  const { tools: bashTools } = await createBashTool({
    uploadDirectory: {
      source: ".",
      include: "**/*.{ts,tsx,js,json,md,yaml,yml}",
    },
    files: skillFiles,
    extraInstructions: skillInstructions,
  });

  return { ...bashTools, skill };
}

function getBashAndSkillTools(): Promise<Record<string, unknown>> {
  if (!bashToolsPromise) {
    bashToolsPromise = loadBashAndSkillTools();
  }
  return bashToolsPromise;
}

// --- Stream part type (simplified from AI SDK's TextStreamPart) ---

interface StreamPart {
  type: string;
  text?: string;
  toolName?: string;
}

// --- Streaming response (Slack) ---
// Pipes text chunks to thread.post(asyncIterable) for real-time streaming.

async function streamToChat(
  fullStream: AsyncIterable<StreamPart>,
  thread: BotThread,
): Promise<void> {
  // Shared state for the async generator bridge
  const state = {
    chunks: [] as string[],
    resolve: null as (() => void) | null,
    done: false,
  };

  async function* textStream(): AsyncGenerator<string> {
    while (true) {
      while (state.chunks.length > 0) yield state.chunks.shift()!;
      if (state.done) return;
      await new Promise<void>((r) => {
        state.resolve = r;
      });
    }
  }

  let currentPost: Promise<unknown> | null = null;
  let inTextBlock = false;

  for await (const part of fullStream) {
    if (part.type === "text-start") {
      inTextBlock = true;
      state.chunks = [];
      state.done = false;
      state.resolve = null;
      currentPost = thread.post(textStream());
    }

    if (part.type === "text-delta" && inTextBlock && part.text) {
      state.chunks.push(part.text);
      state.resolve?.();
    }

    if (part.type === "text-end" && inTextBlock) {
      state.done = true;
      state.resolve?.();
      await currentPost;
      currentPost = null;
      inTextBlock = false;
    }

    if (part.type === "tool-input-start" && part.toolName) {
      console.log(`[rina] tool: ${part.toolName}`);
      const status = TOOL_STATUS[part.toolName];
      if (status) await postWithRetry(thread, `> ${status}`);
    }
  }

  // Safety: close any unclosed stream
  if (inTextBlock) {
    state.done = true;
    state.resolve?.();
    await currentPost;
  }
}

// --- Buffered response (Telegram) ---
// Collects full text blocks, splits at message length limits, posts sequentially.

async function bufferToChat(
  fullStream: AsyncIterable<StreamPart>,
  thread: BotThread,
): Promise<void> {
  let currentTextBlock = "";

  for await (const part of fullStream) {
    if (part.type === "text-start") {
      currentTextBlock = "";
    }

    if (part.type === "text-delta" && part.text) {
      currentTextBlock += part.text;
    }

    if (part.type === "text-end") {
      if (currentTextBlock.trim().length > 0) {
        for (const chunk of splitLongText(currentTextBlock)) {
          await postWithRetry(thread, chunk);
        }
      }
      currentTextBlock = "";
    }

    if (part.type === "tool-input-start" && part.toolName) {
      console.log(`[rina] tool: ${part.toolName}`);
      const status = TOOL_STATUS[part.toolName];
      if (status) await postWithRetry(thread, `> ${status}`);
    }
  }

  // Post any remaining text
  if (currentTextBlock.trim().length > 0) {
    for (const chunk of splitLongText(currentTextBlock)) {
      await postWithRetry(thread, chunk);
    }
  }
}

// --- Main agent entry point ---

export async function handleQuery(
  thread: BotThread,
  content: UserContent,
  opts: { prelude?: string; history?: ModelMessage[] } = {},
): Promise<void> {
  const shouldStream = thread.adapter.name !== "telegram";

  // Build tools
  const arxivTools = createArxivTools(thread);
  const artifactTools = createArtifactTools(thread);
  const extraTools = await getBashAndSkillTools();
  const allTools = {
    ...arxivTools,
    ...artifactTools,
    ...webTools,
    ...extraTools,
  } as ToolSet;

  const agent = new ToolLoopAgent({
    model: anthropic("claude-sonnet-4-6"),
    instructions: SYSTEM_PROMPT,
    tools: allTools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  // Build messages: history first, then prelude, then current user message
  const messages: ModelMessage[] = [...(opts.history ?? [])];
  if (opts.prelude) {
    messages.push({ role: "user", content: opts.prelude });
  }
  messages.push({ role: "user", content });

  const result = await agent.stream({ messages });

  // Cast fullStream to simplified type to avoid deep generics issues
  const stream = result.fullStream as unknown as AsyncIterable<StreamPart>;

  if (shouldStream) {
    await streamToChat(stream, thread);
  } else {
    await bufferToChat(stream, thread);
  }
}
