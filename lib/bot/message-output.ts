import {
  IMAGE_EXT_TO_MIME,
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_IMAGES,
} from "./constants";
import { extractImageUrlsFromText } from "./message-input";
import type { BotThread } from "./types";

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

export async function uploadImageLinksFromResponse(
  thread: BotThread,
  responseText: string,
): Promise<void> {
  const imageUrls = extractImageUrlsFromText(responseText).slice(
    0,
    MAX_OUTBOUND_IMAGES,
  );
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
      // Best-effort upload.
    }
  }

  if (uploadedCount === 0) {
    await thread.post(
      "I found image links in my response, but couldn't upload them to this platform.",
    );
  }
}
