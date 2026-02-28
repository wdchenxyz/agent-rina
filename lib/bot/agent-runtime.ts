import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS, SYSTEM_PROMPT, TOOL_STATUS } from "./constants";
import { uploadImageLinksFromResponse } from "./message-output";
import type { BotThread, QueryPrompt } from "./types";

const RETRY_DELAYS_MS = [400, 1200, 2500];

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
  opts: { resume?: string } = {},
): Promise<string | undefined> {
  let sessionId: string | undefined;
  let fullResponseText = "";

  const shouldLogSdkStderr =
    process.env.CLAUDE_SDK_LOG_STDERR === "1" ||
    process.env.DEBUG_CLAUDE_AGENT_SDK === "1";

  const q = query({
    prompt,
    options: {
      model: "sonnet",
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["WebSearch", "WebFetch", "Task"],
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
        await postWithRetry(thread, currentTextBlock);
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
      await postWithRetry(thread, currentTextBlock);
    }
  }
  await uploadImageLinksFromResponse(thread, fullResponseText);

  return sessionId;
}
