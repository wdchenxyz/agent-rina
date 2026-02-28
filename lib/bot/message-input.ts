import {
  IMAGE_EXT_TO_MIME,
  MAX_INBOUND_IMAGE_BYTES,
  MAX_INBOUND_IMAGES,
  MAX_OUTBOUND_IMAGES,
} from "./constants";
import type { IncomingMessage, QueryPrompt } from "./types";

function getFileExtension(value: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
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

function inferMimeTypeFromUrl(url: string): string | null {
  try {
    const ext = getFileExtension(new URL(url).pathname);
    if (!ext) return null;
    return IMAGE_EXT_TO_MIME[ext] ?? null;
  } catch {
    return null;
  }
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.!?]+$/g, "");
}

function isLikelyImageUrl(url: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|tiff?|svg)(\?.*)?$/i.test(url);
}

export function extractImageUrlsFromText(text: string): string[] {
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

export async function buildPromptFromMessage(
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

      const fallbackMimeType = inferMimeTypeFromUrl(attachment.url || "");
      const mimeType = attachment.mimeType?.startsWith("image/")
        ? attachment.mimeType
        : fallbackMimeType || "image/png";

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
