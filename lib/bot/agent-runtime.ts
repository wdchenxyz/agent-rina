import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS, SYSTEM_PROMPT, TOOL_STATUS } from "./constants";
import { uploadImageLinksFromResponse } from "./message-output";
import { createArxivTools } from "./tools/arxiv";
import type { BotThread, QueryPrompt } from "./types";

const RETRY_DELAYS_MS = [400, 1200, 2500];
const TELEGRAM_MAX_LENGTH = 4000;

function splitLongText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MAX_LENGTH) {
    const slice = remaining.slice(0, TELEGRAM_MAX_LENGTH);
    // Split at last paragraph boundary (\n\n), or last newline, or hard cut
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const withCode = error as Error & {
    code?: string;
    cause?: { code?: string };
    originalError?: { code?: string };
  };

  const directCode = withCode.code;
  const causeCode = withCode.cause?.code;
  const nestedCode = withCode.originalError?.code;
  const message = error.message.toLowerCase();

  return (
    directCode === "NETWORK_ERROR" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    nestedCode === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("network error") ||
    message.includes("connect timeout")
  );
}

async function postWithRetry(
  thread: BotThread,
  message: string | AsyncGenerator<string>,
): Promise<void> {
  let attempt = 0;

  while (true) {
    try {
      await thread.post(message);
      return;
    } catch (error) {
      if (
        attempt >= RETRY_DELAYS_MS.length ||
        !isRetryableNetworkError(error)
      ) {
        throw error;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      attempt += 1;
      await sleep(delay);
    }
  }
}

export async function handleQuery(
  thread: BotThread,
  prompt: QueryPrompt,
  opts: { resume?: string; prelude?: string } = {},
): Promise<string | undefined> {
  let sessionId: string | undefined;
  let fullResponseText = "";

  const shouldLogSdkStderr =
    process.env.CLAUDE_SDK_LOG_STDERR === "1" ||
    process.env.DEBUG_CLAUDE_AGENT_SDK === "1";

  const arxivMcp = createArxivTools(thread);
  const prelude = opts.prelude?.trim();

  const createTextMessage = (text: string) => ({
    type: "user" as const,
    parent_tool_use_id: null,
    message: { role: "user" as const, content: text },
  });

  // Wrap string prompt as async generator when MCP servers are present
  // (SDK requires AsyncIterable<SDKUserMessage> for custom MCP tools)
  let sdkPrompt: QueryPrompt;
  if (typeof prompt === "string") {
    async function* wrapString() {
      if (prelude) {
        yield createTextMessage(prelude);
      }
      yield createTextMessage(prompt as string);
    }
    sdkPrompt = wrapString() as unknown as QueryPrompt;
  } else if (prelude) {
    const preludeText = prelude;
    async function* prependPrelude() {
      yield createTextMessage(preludeText);
      for await (const item of prompt as AsyncIterable<Record<string, unknown>>) {
        yield item;
      }
    }
    sdkPrompt = prependPrelude() as unknown as QueryPrompt;
  } else {
    sdkPrompt = prompt;
  }

  const q = query({
    prompt: sdkPrompt,
    options: {
      model: "opus",
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        "WebSearch",
        "WebFetch",
        "Task",
        "mcp__arxiv__download_arxiv_source",
        "mcp__arxiv__list_paper_files",
        "mcp__arxiv__read_paper_file",
        "mcp__arxiv__upload_paper_figure",
      ],
      mcpServers: { arxiv: arxivMcp },
      agents: AGENTS,
      maxTurns: 20,
      includePartialMessages: true,
      ...(shouldLogSdkStderr
        ? {
            stderr: (data: string) => {
              const value = data.trim();
              if (!value) return;
              console.error(`[claude-sdk stderr] ${value}`);
            },
          }
        : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  });

  let chunks: string[] = [];
  let chunkResolve: (() => void) | null = null;
  let streamDone = false;
  let currentPost: Promise<unknown> | null = null;
  let inTextBlock = false;
  let currentTextBlock = "";
  const streamText = thread.adapter.name !== "telegram";

  async function* textStream(): AsyncGenerator<string> {
    while (true) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (streamDone) return;
      await new Promise<void>((resolve) => {
        chunkResolve = resolve;
      });
    }
  }

  function startTextStream() {
    chunks = [];
    streamDone = false;
    chunkResolve = null;
    currentPost = thread.post(textStream());
  }

  function pushChunk(text: string) {
    chunks.push(text);
    chunkResolve?.();
  }

  async function endTextStream() {
    streamDone = true;
    chunkResolve?.();
    await currentPost;
    currentPost = null;
  }

  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type !== "stream_event" || message.parent_tool_use_id) {
      continue;
    }

    const event = message.event;

    if (
      event.type === "content_block_start" &&
      event.content_block.type === "text"
    ) {
      currentTextBlock = "";
      if (streamText) {
        startTextStream();
      }
      inTextBlock = true;
    }

    if (
      inTextBlock &&
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      currentTextBlock += event.delta.text;
      if (streamText) {
        pushChunk(event.delta.text);
      }
      fullResponseText += event.delta.text;
    }

    if (event.type === "content_block_stop" && inTextBlock) {
      if (streamText) {
        await endTextStream();
      } else if (currentTextBlock.trim().length > 0) {
        for (const part of splitLongText(currentTextBlock)) {
          await postWithRetry(thread, part);
        }
      }
      inTextBlock = false;
    }

    if (
      event.type === "content_block_start" &&
      event.content_block.type === "tool_use"
    ) {
      const status = TOOL_STATUS[event.content_block.name];
      if (status) {
        await postWithRetry(thread, `> ${status}`);
      }
    }
  }

  if (inTextBlock) {
    if (streamText) {
      await endTextStream();
    } else if (currentTextBlock.trim().length > 0) {
      for (const part of splitLongText(currentTextBlock)) {
        await postWithRetry(thread, part);
      }
    }
  }
  await uploadImageLinksFromResponse(thread, fullResponseText);

  return sessionId;
}
