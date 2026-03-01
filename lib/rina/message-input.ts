import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  UserContent,
} from "ai";
import {
  IMAGE_EXT_TO_MIME,
  MAX_INBOUND_ATTACHMENTS,
  MAX_INBOUND_FILE_BYTES,
  MAX_INBOUND_IMAGE_BYTES,
  SUPPORTED_FILE_MIMES,
} from "./constants";
import type { BotThread, IncomingMessage } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A user-content part that can carry media (image or file). */
type MediaPart = ImagePart | FilePart;

/** Any part we put inside a UserContent array. */
type ContentPart = TextPart | MediaPart;

function getFileExtension(value: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function inferMimeTypeFromUrl(url: string): string | null {
  try {
    const ext = getFileExtension(new URL(url).pathname);
    if (!ext) return null;
    return IMAGE_EXT_TO_MIME[ext] ?? null;
  } catch {
    return null;
  }
}

/** True when the MIME type can be sent to the model (image, PDF, text). */
function isSupportedMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.startsWith("image/") || SUPPORTED_FILE_MIMES.has(mime);
}

// ---------------------------------------------------------------------------
// Attachment reading
// ---------------------------------------------------------------------------

async function readAttachmentData(
  attachment: IncomingMessage["attachments"][number],
): Promise<Buffer | null> {
  if (attachment.data instanceof Buffer) return attachment.data;
  if (attachment.data instanceof Blob) {
    return Buffer.from(await attachment.data.arrayBuffer());
  }
  if (attachment.fetchData) return attachment.fetchData();
  return null;
}

// ---------------------------------------------------------------------------
// Build a single MediaPart from an attachment
// ---------------------------------------------------------------------------

/**
 * Try to convert one attachment into an AI SDK ImagePart or FilePart.
 * Returns `null` when the attachment is unsupported, too large, or unreadable.
 */
async function attachmentToMediaPart(
  attachment: IncomingMessage["attachments"][number],
): Promise<MediaPart | null> {
  const data = await readAttachmentData(attachment);
  if (!data) return null;

  // Resolve MIME
  const rawMime = attachment.mimeType ?? "";
  const isImage = rawMime.startsWith("image/");
  const isPdfOrText = SUPPORTED_FILE_MIMES.has(rawMime);

  if (isImage) {
    if (data.length > MAX_INBOUND_IMAGE_BYTES) return null;
    const fallback = inferMimeTypeFromUrl(attachment.url || "");
    const mimeType = rawMime || fallback || "image/png";
    return { type: "image", image: data, mediaType: mimeType };
  }

  if (isPdfOrText) {
    if (data.length > MAX_INBOUND_FILE_BYTES) return null;
    return {
      type: "file",
      data,
      mediaType: rawMime,
      filename: attachment.name ?? undefined,
    };
  }

  // Try inferring from URL extension (covers image links with no mimeType)
  const inferred = inferMimeTypeFromUrl(attachment.url || "");
  if (inferred?.startsWith("image/")) {
    if (data.length > MAX_INBOUND_IMAGE_BYTES) return null;
    return { type: "image", image: data, mediaType: inferred };
  }

  return null; // unsupported type
}

// ---------------------------------------------------------------------------
// buildPromptFromMessage — current message → UserContent
// ---------------------------------------------------------------------------

/** Build a short `[user: @handle (ID)]` prefix from a message author. */
function authorPrefix(author: IncomingMessage["author"]): string {
  if (!author || author.isMe) return "";
  const name = author.userName || author.fullName || "";
  const id = author.userId ?? "";
  if (name && id) return `[user: @${name} (${id})] `;
  if (id) return `[user: ${id}] `;
  if (name) return `[user: @${name}] `;
  return "";
}

/**
 * Convert an incoming chat message into AI SDK prompt content.
 * Supports image, PDF, and plain-text attachments.
 */
export async function buildPromptFromMessage(
  message: IncomingMessage,
): Promise<{ content: UserContent; warnings: string[] }> {
  const prefix = authorPrefix(message.author);
  const text = (prefix + (message.text?.trim() ?? "")).trim();
  const supportedAttachments = (message.attachments ?? []).filter((a) =>
    isSupportedMime(a.mimeType) || a.type === "image",
  );

  console.log(
    `[rina:image-debug] buildPromptFromMessage: text="${text}", total attachments=${message.attachments?.length ?? 0}, supported attachments=${supportedAttachments.length}`,
  );
  for (const att of supportedAttachments) {
    console.log(
      `[rina:image-debug]   attachment: name=${att.name}, type=${att.type}, mimeType=${att.mimeType}, url=${att.url?.slice(0, 80)}...`,
    );
  }

  if (supportedAttachments.length === 0) {
    return { content: text || "Hello", warnings: [] };
  }

  const warnings: string[] = [];
  const parts: ContentPart[] = [
    { type: "text", text: text || "Please analyze the attached file(s)." },
  ];

  for (const [index, attachment] of supportedAttachments
    .slice(0, MAX_INBOUND_ATTACHMENTS)
    .entries()) {
    try {
      const part = await attachmentToMediaPart(attachment);
      if (!part) {
        console.log(
          `[rina:image-debug]   attachment #${index + 1}: unsupported or unreadable (name=${attachment.name}, mime=${attachment.mimeType})`,
        );
        warnings.push(`Couldn't read attachment #${index + 1} (${attachment.name ?? "unknown"}); skipped it.`);
        continue;
      }
      console.log(
        `[rina:image-debug]   attachment #${index + 1}: OK, type=${part.type}, name=${attachment.name}`,
      );
      parts.push(part);
    } catch (err) {
      console.error(`[rina:image-debug]   attachment #${index + 1}: error downloading`, err);
      warnings.push(`Couldn't process attachment #${index + 1}; skipped it.`);
    }
  }

  if (supportedAttachments.length > MAX_INBOUND_ATTACHMENTS) {
    warnings.push(
      `Only the first ${MAX_INBOUND_ATTACHMENTS} attachments were sent to the model.`,
    );
  }

  // If nothing could be read, fall back to text-only
  if (parts.length === 1) {
    return {
      content:
        text ||
        "I tried to process your attachments, but none could be read. Ask me to re-upload.",
      warnings,
    };
  }

  return { content: parts, warnings };
}

// ---------------------------------------------------------------------------
// extractMediaParts — pull supported media from any message
// ---------------------------------------------------------------------------

/**
 * Extract image/PDF/text attachments from a message as AI SDK parts.
 * Silently skips unsupported or unreadable attachments.
 */
async function extractMediaParts(
  message: IncomingMessage,
): Promise<MediaPart[]> {
  const candidates = (message.attachments ?? []).filter(
    (a) => isSupportedMime(a.mimeType) || a.type === "image",
  );
  const parts: MediaPart[] = [];

  for (const attachment of candidates.slice(0, MAX_INBOUND_ATTACHMENTS)) {
    try {
      const part = await attachmentToMediaPart(attachment);
      if (part) parts.push(part);
    } catch {
      // Skip unreadable attachments silently in history
    }
  }

  return parts;
}

// ---------------------------------------------------------------------------
// convertThreadHistory
// ---------------------------------------------------------------------------

/**
 * Fetch all messages from a thread and convert them to AI SDK ModelMessage[].
 *
 * - Messages authored by the bot (author.isMe) become assistant messages.
 * - All other messages become user messages (with media attachments if present).
 * - The current incoming message is excluded to avoid duplication.
 *
 * Returns messages in chronological order (oldest first).
 */
export async function convertThreadHistory(
  thread: BotThread,
  currentMessageId: string,
): Promise<ModelMessage[]> {
  const history: ModelMessage[] = [];

  for await (const msg of thread.allMessages) {
    if (msg.id === currentMessageId) continue;

    const text = msg.text?.trim() ?? "";
    if (!text && (!msg.attachments || msg.attachments.length === 0)) continue;

    console.log(
      `[rina:image-debug] history msg: id=${msg.id}, isMe=${msg.author.isMe}, text="${text.slice(0, 60)}", attachments=${msg.attachments?.length ?? 0}`,
    );

    if (msg.author.isMe) {
      // Bot's own messages → assistant role (text only, since the AI SDK
      // doesn't support images/files in assistant content).
      if (text) {
        history.push({ role: "assistant", content: text });
      }

      // When the bot posted files (e.g. via uploadArtifact), inject a
      // synthetic user message so the model can "see" what it uploaded.
      // This is necessary because users may refer back to these files.
      const botMediaParts = await extractMediaParts(msg);
      if (botMediaParts.length > 0) {
        console.log(
          `[rina:image-debug]   -> bot msg has ${botMediaParts.length} file(s), injecting as user context`,
        );
        history.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "[This is the file you just posted to the chat.]",
            },
            ...botMediaParts,
          ],
        });
      }
    } else {
      // Other users' messages → user role with optional media
      const mediaParts = await extractMediaParts(msg);
      const prefix = authorPrefix(msg.author);
      const labeledText = (prefix + text).trim();

      console.log(
        `[rina:image-debug]   -> user msg added with ${mediaParts.length} file(s)`,
      );

      if (mediaParts.length > 0) {
        history.push({
          role: "user",
          content: [
            { type: "text", text: labeledText || "See attached file(s)." },
            ...mediaParts,
          ],
        });
      } else {
        history.push({
          role: "user",
          content: labeledText || "(empty message)",
        });
      }
    }
  }

  // Anthropic requires strictly alternating user/assistant roles.
  // Merge consecutive same-role messages to avoid API errors (e.g. when a
  // synthetic user file message is followed by a real user message).
  const merged: ModelMessage[] = [];
  for (const msg of history) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && prev.role === "user") {
      const prevParts: ContentPart[] =
        typeof prev.content === "string"
          ? [{ type: "text" as const, text: prev.content }]
          : (prev.content as ContentPart[]);
      const curParts: ContentPart[] =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : (msg.content as ContentPart[]);
      prev.content = [...prevParts, ...curParts] as UserContent;
    } else if (prev && prev.role === msg.role && prev.role === "assistant") {
      // Merge consecutive assistant text messages
      const prevText =
        typeof prev.content === "string" ? prev.content : "";
      const curText =
        typeof msg.content === "string" ? msg.content : "";
      prev.content = [prevText, curText].filter(Boolean).join("\n\n");
    } else {
      merged.push({ ...msg });
    }
  }

  console.log(
    `[rina:image-debug] convertThreadHistory: ${merged.length} messages total (${history.length} before merge)`,
  );
  return merged;
}
