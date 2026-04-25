import type { StreamPart } from "./agent";
import { getToolStatus } from "./tools/registry";
import { extractFileUploads, type FileUploadResult } from "./tools/results";
import type { BotThread } from "./types";

const RETRY_DELAYS_MS = [400, 1200, 2500];
const TELEGRAM_MAX_LENGTH = 4000;

type ChatPostFile = {
  data: Buffer;
  filename: string;
  mimeType: string;
};

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

function isTelegramMarkdownValidationError(
  thread: BotThread,
  error: unknown,
): boolean {
  if (thread.adapter.name !== "telegram" || !(error instanceof Error)) {
    return false;
  }

  const withDetails = error as Error & {
    adapter?: string;
    code?: string;
  };
  const message = error.message.toLowerCase();

  return (
    withDetails.code === "VALIDATION_ERROR" &&
    (withDetails.adapter === "telegram" || message.includes("bad request")) &&
    message.includes("parse entities")
  );
}

async function postMarkdownOrRaw(
  thread: BotThread,
  content: string,
  files?: ChatPostFile[],
): Promise<void> {
  try {
    if (files?.length) {
      await thread.post({ markdown: content, files });
    } else {
      await thread.post({ markdown: content });
    }
    return;
  } catch (error) {
    if (!isTelegramMarkdownValidationError(thread, error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[rina:telegram] Markdown rejected by Telegram; retrying as raw text.",
      message,
    );
  }

  if (files?.length) {
    await thread.post({ raw: content, files });
  } else {
    await thread.post({ raw: content });
  }
}

async function postWithRetry(
  thread: BotThread,
  content: string,
  files?: ChatPostFile[],
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await postMarkdownOrRaw(thread, content, files);
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

async function postToolStatus(
  thread: BotThread,
  part: StreamPart,
): Promise<void> {
  if (part.type !== "tool-input-start" || !part.toolName) return;

  console.log(`[rina] tool: ${part.toolName}`);
  const status = getToolStatus(part.toolName);
  if (status) {
    await postWithRetry(thread, `> ${status}`);
  }
}

async function postBufferedText(
  thread: BotThread,
  text: string,
): Promise<void> {
  if (text.trim().length === 0) return;

  for (const chunk of splitLongText(text)) {
    await postWithRetry(thread, chunk);
  }
}

// --- File upload interception ---

async function postFileUpload(
  upload: FileUploadResult,
  thread: BotThread,
): Promise<void> {
  const data = Buffer.from(upload.dataBase64, "base64");
  await postWithRetry(thread, upload.caption, [
    { data, filename: upload.filename, mimeType: upload.mimeType },
  ]);
}

/**
 * Check tool-result parts for structured file upload outputs. Tools return
 * typed FileUploadResult objects (single or in an array) — the delivery
 * layer intercepts them and posts files to chat.
 */
async function handleToolResultUploads(
  part: StreamPart,
  thread: BotThread,
): Promise<void> {
  if (part.type !== "tool-result") return;

  const raw = (part as StreamPart & { output?: unknown }).output
    ?? (part as StreamPart & { result?: unknown }).result;

  for (const file of extractFileUploads(raw)) {
    await postFileUpload(file, thread);
  }
}

// --- Stream bridge for real-time streaming ---

type TextStreamBridge = ReturnType<typeof createTextStreamBridge>;

function createTextStreamBridge(): {
  stream: AsyncGenerator<string>;
  push: (chunk: string) => void;
  close: () => void;
} {
  const state = {
    chunks: [] as string[],
    resolve: null as (() => void) | null,
    done: false,
  };

  async function* stream(): AsyncGenerator<string> {
    while (true) {
      while (state.chunks.length > 0) {
        yield state.chunks.shift()!;
      }
      if (state.done) return;
      await new Promise<void>((resolve) => {
        state.resolve = resolve;
      });
    }
  }

  return {
    stream: stream(),
    push(chunk: string) {
      state.chunks.push(chunk);
      state.resolve?.();
    },
    close() {
      state.done = true;
      state.resolve?.();
    },
  };
}

// --- Stream consumption with text block handlers ---

type TextBlockStreamHandlers = {
  onTextStart?: () => Promise<void> | void;
  onTextDelta?: (text: string) => Promise<void> | void;
  onTextEnd?: () => Promise<void> | void;
};

async function consumeStream(
  fullStream: AsyncIterable<StreamPart>,
  thread: BotThread,
  handlers: TextBlockStreamHandlers,
): Promise<void> {
  const announcedTools = new Set<string>();

  for await (const part of fullStream) {
    if (part.type === "text-start") {
      await handlers.onTextStart?.();
    }

    if (part.type === "text-delta" && part.text) {
      await handlers.onTextDelta?.(part.text);
    }

    if (part.type === "text-end") {
      await handlers.onTextEnd?.();
    }

    if (part.toolName && !announcedTools.has(part.toolName)) {
      announcedTools.add(part.toolName);
      await postToolStatus(thread, part);
    }
    await handleToolResultUploads(part, thread);
  }
}

// --- Streaming delivery (Slack) ---

async function streamToChat(
  fullStream: AsyncIterable<StreamPart>,
  thread: BotThread,
): Promise<void> {
  let bridge: TextStreamBridge | null = null;
  let currentPost: Promise<unknown> | null = null;

  await consumeStream(fullStream, thread, {
    onTextStart() {
      bridge = createTextStreamBridge();
      currentPost = thread.post(bridge.stream);
    },
    onTextDelta(text) {
      bridge?.push(text);
    },
    async onTextEnd() {
      if (!bridge) return;
      bridge.close();
      await currentPost;
      currentPost = null;
      bridge = null;
    },
  });

  // Safety: close any unclosed stream
  const openBridge = bridge as unknown as TextStreamBridge | null;
  if (openBridge) {
    openBridge.close();
    await currentPost;
  }
}

// --- Buffered delivery (Telegram) ---

async function bufferToChat(
  fullStream: AsyncIterable<StreamPart>,
  thread: BotThread,
): Promise<void> {
  let currentTextBlock = "";

  await consumeStream(fullStream, thread, {
    onTextStart() {
      currentTextBlock = "";
    },
    onTextDelta(text) {
      currentTextBlock += text;
    },
    async onTextEnd() {
      await postBufferedText(thread, currentTextBlock);
      currentTextBlock = "";
    },
  });

  // Post any remaining text
  await postBufferedText(thread, currentTextBlock);
}

// --- Public API ---

/**
 * Deliver an agent stream to a chat thread.
 * Chooses streaming (Slack) or buffered (Telegram) mode based on the adapter.
 * Intercepts structured file upload results from tools and posts them as attachments.
 */
export async function deliverToChat(
  stream: AsyncIterable<StreamPart>,
  thread: BotThread,
): Promise<void> {
  const shouldStream = thread.adapter.name !== "telegram";

  if (shouldStream) {
    await streamToChat(stream, thread);
  } else {
    await bufferToChat(stream, thread);
  }
}
