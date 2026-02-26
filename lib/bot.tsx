import { Chat, emoji } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MAX_INBOUND_IMAGES = 4;
const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTBOUND_IMAGES = 3;
const MAX_OUTBOUND_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

const SYSTEM_PROMPT = `You are Rina, a friendly, clever, adorable, and intelligent female AI assistant. Keep your responses concise, conversational, and approachable, with a touch of charm and wit when appropriate.

Before using any tool or spawning a subagent, briefly tell the user what you’re about to do in one short sentence (e.g., "Let me search the web for that." or "I’ll have my researcher look into this."). Then proceed with the action.`;

const TOOL_STATUS: Record<string, string> = {
  Task: "Spawning subagent...",
  WebSearch: "Searching the web...",
  WebFetch: "Fetching page...",
};

const AGENTS = {
  researcher: {
    description:
      "Web research specialist. Use when you need to find current information, news, or facts from the internet.",
    prompt:
      "You are a web research specialist. Search the web to find accurate, up-to-date information. Summarize findings concisely.",
    tools: ["WebSearch", "WebFetch"],
    model: "haiku" as const,
  },
};

export const bot = new Chat({
  userName: "mybot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createRedisState(),
});

type Thread = Parameters<Parameters<typeof bot.onNewMention>[0]>[0];
type IncomingMessage = Parameters<Parameters<typeof bot.onNewMention>[0]>[1];
type QueryPrompt = Parameters<typeof query>[0]["prompt"];

function getFileExtension(value: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function inferMimeTypeFromUrl(url: string): string | null {
  const ext = getFileExtension(new URL(url).pathname);
  if (!ext) return null;
  return IMAGE_EXT_TO_MIME[ext] ?? null;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "image";
}

function extensionForMimeType(mimeType: string): string {
  const entry = Object.entries(IMAGE_EXT_TO_MIME).find(
    ([, mime]) => mime === mimeType,
  );
  return entry?.[0] ?? "png";
}

function buildFilename(url: string, mimeType: string): string {
  const pathname = new URL(url).pathname;
  const rawName = pathname.split("/").pop() || "image";
  const sanitized = sanitizeFilename(rawName);
  if (getFileExtension(sanitized)) return sanitized;
  return `${sanitized}.${extensionForMimeType(mimeType)}`;
}

function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function isPrivateOrLocalHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  ) {
    return true;
  }

  const ipv4 = parseIPv4(normalized);
  if (!ipv4) return false;
  const [a, b] = ipv4;

  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.!?]+$/g, "");
}

function isLikelyImageUrl(url: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|tiff?|svg)(\?.*)?$/i.test(url);
}

function extractImageUrlsFromText(text: string): string[] {
  const urls = new Set<string>();

  const markdownImageRegex = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownImageRegex.exec(text)) !== null) {
    const value = stripTrailingPunctuation(markdownMatch[1]);
    urls.add(value);
  }

  const bareUrlRegex = /(https?:\/\/[^\s<>"'`]+)/gi;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = bareUrlRegex.exec(text)) !== null) {
    const value = stripTrailingPunctuation(bareMatch[1]);
    if (isLikelyImageUrl(value)) {
      urls.add(value);
    }
  }

  return [...urls]
    .filter((rawUrl) => {
      try {
        const url = new URL(rawUrl);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          !isPrivateOrLocalHost(url.hostname)
        );
      } catch {
        return false;
      }
    })
    .slice(0, MAX_OUTBOUND_IMAGES);
}

async function readAttachmentData(
  attachment: IncomingMessage["attachments"][number],
): Promise<Buffer | null> {
  if (attachment.data instanceof Buffer) {
    return attachment.data;
  }
  if (attachment.data instanceof Blob) {
    return Buffer.from(await attachment.data.arrayBuffer());
  }
  if (attachment.fetchData) {
    return attachment.fetchData();
  }
  return null;
}

async function buildPromptFromMessage(
  message: IncomingMessage,
): Promise<{ prompt: QueryPrompt; warnings: string[] }> {
  const text = message.text?.trim() ?? "";
  const imageAttachments = (message.attachments ?? []).filter(
    (attachment) => attachment.type === "image",
  );

  if (imageAttachments.length === 0) {
    return { prompt: text, warnings: [] };
  }

  const warnings: string[] = [];
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: text || "Please analyze the attached image(s)." },
  ];

  for (const [index, attachment] of imageAttachments
    .slice(0, MAX_INBOUND_IMAGES)
    .entries()) {
    try {
      const data = await readAttachmentData(attachment);
      if (!data) {
        warnings.push(`Couldn't read image #${index + 1}; skipped it.`);
        continue;
      }
      if (data.length > MAX_INBOUND_IMAGE_BYTES) {
        warnings.push(
          `Image #${index + 1} is larger than ${MAX_INBOUND_IMAGE_BYTES / (1024 * 1024)}MB; skipped it.`,
        );
        continue;
      }

      const mimeType =
        attachment.mimeType?.startsWith("image/") ? attachment.mimeType : "image/png";

      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: data.toString("base64"),
        },
      });
    } catch {
      warnings.push(`Couldn't process image #${index + 1}; skipped it.`);
    }
  }

  if (imageAttachments.length > MAX_INBOUND_IMAGES) {
    warnings.push(`Only the first ${MAX_INBOUND_IMAGES} images were sent to Claude.`);
  }

  if (content.length === 1) {
    const fallbackPrompt =
      text ||
      "I tried to attach images, but none could be read. Ask me to re-upload the images.";
    return { prompt: fallbackPrompt, warnings };
  }

  async function* promptStream(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content,
      },
    };
  }

  return { prompt: promptStream() as unknown as QueryPrompt, warnings };
}

async function downloadRemoteImage(
  rawUrl: string,
): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
  const response = await fetch(rawUrl);
  if (!response.ok) return null;

  const contentTypeHeader = response.headers.get("content-type");
  const mimeType = contentTypeHeader?.split(";")[0].trim().toLowerCase() || "";
  const inferredMimeType = inferMimeTypeFromUrl(rawUrl);
  const finalMimeType = mimeType.startsWith("image/")
    ? mimeType
    : inferredMimeType || "image/png";

  if (!finalMimeType.startsWith("image/")) return null;

  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  if (data.length === 0 || data.length > MAX_OUTBOUND_IMAGE_BYTES) return null;

  return {
    data,
    mimeType: finalMimeType,
    filename: buildFilename(rawUrl, finalMimeType),
  };
}

async function uploadImageLinksFromResponse(
  thread: Thread,
  responseText: string,
): Promise<void> {
  const imageUrls = extractImageUrlsFromText(responseText);
  if (imageUrls.length === 0) return;

  let uploadedCount = 0;
  for (const imageUrl of imageUrls) {
    try {
      const file = await downloadRemoteImage(imageUrl);
      if (!file) continue;

      await thread.post({
        markdown: `Uploaded image from ${imageUrl}`,
        files: [
          {
            data: file.data,
            filename: file.filename,
            mimeType: file.mimeType,
          },
        ],
      });
      uploadedCount += 1;
    } catch {
      // Best-effort upload; keep the rest going.
    }
  }

  if (uploadedCount === 0) {
    await thread.post(
      "I found image links in my response, but couldn't upload them to Slack.",
    );
  }
}

async function handleQuery(
  thread: Thread,
  prompt: QueryPrompt,
  opts: { resume?: string } = {},
): Promise<string | undefined> {
  let sessionId: string | undefined;
  let fullResponseText = "";

  const q = query({
    prompt,
    options: {
      model: "sonnet",
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      allowedTools: ["WebSearch", "WebFetch", "Task"],
      agents: AGENTS,
      maxTurns: 20,
      includePartialMessages: true,
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  });

  // State for streaming text to thread.post() concurrently
  let chunks: string[] = [];
  let chunkResolve: (() => void) | null = null;
  let streamDone = false;
  let currentPost: Promise<unknown> | null = null;

  async function* textStream(): AsyncGenerator<string> {
    while (true) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (streamDone) return;
      await new Promise<void>((r) => (chunkResolve = r));
    }
  }

  function startTextStream() {
    chunks = [];
    streamDone = false;
    chunkResolve = null;
    // Start posting — don't await, let it consume concurrently
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

  let inTextBlock = false;

  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type !== "stream_event" || message.parent_tool_use_id) {
      continue;
    }

    const event = message.event;

    // New text content block → start streaming a new message
    if (
      event.type === "content_block_start" &&
      event.content_block.type === "text"
    ) {
      startTextStream();
      inTextBlock = true;
    }

    // Text delta → push to the active stream
    if (
      inTextBlock &&
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      pushChunk(event.delta.text);
      fullResponseText += event.delta.text;
    }

    // Content block ended → finalize the message
    if (event.type === "content_block_stop" && inTextBlock) {
      await endTextStream();
      inTextBlock = false;
    }

    // Tool use → post status as a separate message
    if (
      event.type === "content_block_start" &&
      event.content_block.type === "tool_use"
    ) {
      const status = TOOL_STATUS[event.content_block.name];
      if (status) await thread.post(`> ${status}`);
    }
  }

  // Close any dangling stream
  if (inTextBlock) await endTextStream();
  await uploadImageLinksFromResponse(thread, fullResponseText);

  return sessionId;
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.adapter.addReaction(message.threadId, message.id, emoji.eyes);

  const { prompt, warnings } = await buildPromptFromMessage(message);
  if (warnings.length > 0) {
    await thread.post(warnings.map((warning) => `> ${warning}`).join("\n"));
  }

  const sessionId = await handleQuery(thread, prompt);
  if (sessionId) await thread.setState({ sdkSessionId: sessionId });

  await thread.adapter.removeReaction(message.threadId, message.id, emoji.eyes);
  await thread.adapter.addReaction(message.threadId, message.id, emoji.check);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.adapter.addReaction(message.threadId, message.id, emoji.eyes);

  const state = await thread.state;
  const { prompt, warnings } = await buildPromptFromMessage(message);
  if (warnings.length > 0) {
    await thread.post(warnings.map((warning) => `> ${warning}`).join("\n"));
  }

  const sessionId = await handleQuery(thread, prompt, {
    resume: state?.sdkSessionId as string | undefined,
  });
  if (sessionId) await thread.setState({ sdkSessionId: sessionId });

  await thread.adapter.removeReaction(message.threadId, message.id, emoji.eyes);
  await thread.adapter.addReaction(message.threadId, message.id, emoji.check);
});
