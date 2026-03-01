import type { ImagePart, ModelMessage, TextPart, UserContent } from "ai";
import {
  IMAGE_EXT_TO_MIME,
  MAX_INBOUND_IMAGE_BYTES,
  MAX_INBOUND_IMAGES,
} from "./constants";
import type { BotThread, IncomingMessage } from "./types";

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

// --- Attachment reading ---

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

/**
 * Convert an incoming chat message into AI SDK prompt content.
 * Returns UserContent (string or array of text+image parts) + any warnings.
 */
export async function buildPromptFromMessage(
  message: IncomingMessage,
): Promise<{ content: UserContent; warnings: string[] }> {
  const text = message.text?.trim() ?? "";
  const imageAttachments = (message.attachments ?? []).filter(
    (a) => a.type === "image",
  );

  console.log(
    `[rina:image-debug] buildPromptFromMessage: text="${text}", total attachments=${message.attachments?.length ?? 0}, image attachments=${imageAttachments.length}`,
  );
  for (const att of imageAttachments) {
    console.log(
      `[rina:image-debug]   attachment: name=${att.name}, mimeType=${att.mimeType}, url=${att.url?.slice(0, 80)}...`,
    );
  }

  if (imageAttachments.length === 0) {
    return { content: text || "Hello", warnings: [] };
  }

  const warnings: string[] = [];
  const parts: Array<TextPart | ImagePart> = [
    { type: "text", text: text || "Please analyze the attached image(s)." },
  ];

  for (const [index, attachment] of imageAttachments
    .slice(0, MAX_INBOUND_IMAGES)
    .entries()) {
    try {
      const data = await readAttachmentData(attachment);
      if (!data) {
        console.log(`[rina:image-debug]   image #${index + 1}: fetchData returned null`);
        warnings.push(`Couldn't read image #${index + 1}; skipped it.`);
        continue;
      }
      console.log(
        `[rina:image-debug]   image #${index + 1}: downloaded ${data.length} bytes, name=${attachment.name}`,
      );
      if (data.length > MAX_INBOUND_IMAGE_BYTES) {
        warnings.push(
          `Image #${index + 1} is larger than ${MAX_INBOUND_IMAGE_BYTES / (1024 * 1024)}MB; skipped it.`,
        );
        continue;
      }

      const fallbackMime = inferMimeTypeFromUrl(attachment.url || "");
      const mimeType = attachment.mimeType?.startsWith("image/")
        ? attachment.mimeType
        : fallbackMime || "image/png";

      parts.push({
        type: "image",
        image: data,
        mediaType: mimeType,
      });
    } catch (err) {
      console.error(`[rina:image-debug]   image #${index + 1}: error downloading`, err);
      warnings.push(`Couldn't process image #${index + 1}; skipped it.`);
    }
  }

  if (imageAttachments.length > MAX_INBOUND_IMAGES) {
    warnings.push(
      `Only the first ${MAX_INBOUND_IMAGES} images were sent to the model.`,
    );
  }

  // If no images could be read, fall back to text-only
  if (parts.length === 1) {
    return {
      content:
        text ||
        "I tried to attach images, but none could be read. Ask me to re-upload.",
      warnings,
    };
  }

  return { content: parts, warnings };
}

// --- Thread history conversion ---

/**
 * Convert a single chat Message's image attachments into AI SDK ImagePart[].
 * Silently skips any attachments that fail to load or exceed size limits.
 */
async function extractImageParts(
  message: IncomingMessage,
): Promise<ImagePart[]> {
  const images = (message.attachments ?? []).filter((a) => a.type === "image");
  const parts: ImagePart[] = [];

  for (const attachment of images.slice(0, MAX_INBOUND_IMAGES)) {
    try {
      const data = await readAttachmentData(attachment);
      if (!data || data.length > MAX_INBOUND_IMAGE_BYTES) continue;

      const fallbackMime = inferMimeTypeFromUrl(attachment.url || "");
      const mimeType = attachment.mimeType?.startsWith("image/")
        ? attachment.mimeType
        : fallbackMime || "image/png";

      parts.push({ type: "image", image: data, mediaType: mimeType });
    } catch {
      // Skip unreadable attachments silently in history
    }
  }

  return parts;
}

/**
 * Fetch all messages from a thread and convert them to AI SDK ModelMessage[].
 *
 * - Messages authored by the bot (author.isMe) become assistant messages.
 * - All other messages become user messages (with image attachments if present).
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
      `[rina:image-debug] history msg: id=${msg.id}, isMe=${msg.author.isMe}, text="${text.slice(0, 60)}", attachments=${msg.attachments?.length ?? 0}, imageAttachments=${(msg.attachments ?? []).filter((a) => a.type === "image").length}`,
    );

    if (msg.author.isMe) {
      // Bot's own messages → assistant role (text only, since the AI SDK
      // doesn't support images in assistant content).
      if (text) {
        history.push({ role: "assistant", content: text });
      }

      // When the bot posted images (e.g. via uploadArtifact), inject a
      // synthetic user message so the model can "see" what it uploaded.
      // This is necessary because users may refer back to these images.
      const botImageParts = await extractImageParts(msg);
      if (botImageParts.length > 0) {
        console.log(
          `[rina:image-debug]   -> bot msg has ${botImageParts.length} image(s), injecting as user context`,
        );
        history.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "[This is the image you just posted to the chat.]",
            },
            ...botImageParts,
          ],
        });
      }
    } else {
      // Other users' messages → user role with optional images
      const imageParts = await extractImageParts(msg);

      console.log(
        `[rina:image-debug]   -> user msg added with ${imageParts.length} image(s)`,
      );

      if (imageParts.length > 0) {
        history.push({
          role: "user",
          content: [
            { type: "text", text: text || "See attached image(s)." },
            ...imageParts,
          ],
        });
      } else {
        history.push({
          role: "user",
          content: text || "(empty message)",
        });
      }
    }
  }

  // Anthropic requires strictly alternating user/assistant roles.
  // Merge consecutive same-role messages to avoid API errors (e.g. when a
  // synthetic user image message is followed by a real user message).
  const merged: ModelMessage[] = [];
  for (const msg of history) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && prev.role === "user") {
      // Normalise both contents to part arrays and concatenate
      const prevParts: Array<TextPart | ImagePart> =
        typeof prev.content === "string"
          ? [{ type: "text" as const, text: prev.content }]
          : (prev.content as Array<TextPart | ImagePart>);
      const curParts: Array<TextPart | ImagePart> =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : (msg.content as Array<TextPart | ImagePart>);
      prev.content = [...prevParts, ...curParts];
    } else if (prev && prev.role === msg.role && prev.role === "assistant") {
      // Merge consecutive assistant text messages
      const prevText = typeof prev.content === "string"
        ? prev.content
        : "";
      const curText = typeof msg.content === "string"
        ? msg.content
        : "";
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
