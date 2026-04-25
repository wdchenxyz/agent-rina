import { tool } from "ai";
import type { DefuddleResponse } from "defuddle/node";
import { parseHTML } from "linkedom";
import { z } from "zod";

import {
  toolResult,
  toolResultToModelText,
  type FileUploadResult,
  type RinaToolResult,
} from "./results";
import { decodeResponseText, safeFetchBuffer } from "./safe-fetch";

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 3;
const HARD_MAX_IMAGES = 5;
const MODEL_CONTENT_CHARS = 12_000;
const DATA_PREVIEW_CHARS = 2_500;
const IMAGE_VALIDATION_LIMIT = 10;

const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

type ImageSource = "article" | "defuddle" | "figure" | "jsonld" | "metadata" | "picture";

interface RawImageCandidate {
  url: string;
  source: ImageSource;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
  context?: string;
}

interface RankedImageCandidate extends RawImageCandidate {
  score: number;
  reason: string;
}

interface PostedImage {
  url: string;
  filename: string;
  mimeType: string;
  bytes: number;
  score: number;
  alt?: string;
  caption?: string;
  reason: string;
}

function isHtmlContentType(contentType: string): boolean {
  if (!contentType) return true;
  return (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml")
  );
}

function isSupportedImageContentType(contentType: string): boolean {
  const mimeType = normalizeMimeType(contentType);
  return mimeType in IMAGE_MIME_TO_EXTENSION;
}

function normalizeMimeType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated]`;
}

function cleanText(text: string | null | undefined): string | undefined {
  const cleaned = text?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function stripHtmlToText(html: string): string {
  const { document } = parseHTML(html);
  return document.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function extractedContent(result: DefuddleResponse): string {
  const markdown = result.contentMarkdown?.trim();
  if (markdown) return markdown;

  const content = result.content?.trim() ?? "";
  if (!content) return "";

  if (/^\s*</.test(content) || /<\/(article|blockquote|div|h[1-6]|li|ol|p|pre|section|table|ul)>/i.test(content)) {
    return stripHtmlToText(content);
  }

  return content;
}

async function parseReadablePage(
  document: Document,
  url: string,
): Promise<DefuddleResponse> {
  const { Defuddle } = await import("defuddle/node");
  return Defuddle(document, url, {
    markdown: true,
    separateMarkdown: true,
    useAsync: false,
  });
}

function clampMaxImages(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_IMAGES;
  return Math.max(0, Math.min(HARD_MAX_IMAGES, Math.floor(value)));
}

function toAbsoluteUrl(raw: string | undefined | null, baseUrl: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /^(data|blob|javascript):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseDimension(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function pickBestFromSrcset(srcset: string | null | undefined, baseUrl: string): string | null {
  if (!srcset) return null;
  const entries = srcset
    .split(/,\s+(?=\S+(?:\s+(?:\d+w|\d+(?:\.\d+)?x))?)/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  let best: { url: string; score: number } | null = null;
  for (const entry of entries) {
    const [urlPart, descriptor] = entry.split(/\s+/);
    const url = toAbsoluteUrl(urlPart, baseUrl);
    if (!url) continue;
    let score = 1;
    if (descriptor?.endsWith("w")) {
      score = Number.parseInt(descriptor, 10) || score;
    } else if (descriptor?.endsWith("x")) {
      score = (Number.parseFloat(descriptor) || 1) * 1000;
    }
    if (!best || score > best.score) best = { url, score };
  }

  return best?.url ?? null;
}

function getImageUrl(element: Element, baseUrl: string): string | null {
  const srcsetUrl =
    pickBestFromSrcset(element.getAttribute("srcset"), baseUrl) ??
    pickBestFromSrcset(element.getAttribute("data-srcset"), baseUrl);
  if (srcsetUrl) return srcsetUrl;

  for (const attr of ["src", "data-src", "data-original", "data-lazy-src", "data-url", "poster"]) {
    const url = toAbsoluteUrl(element.getAttribute(attr), baseUrl);
    if (url) return url;
  }

  return null;
}

function imageKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  return parsed.toString();
}

function addCandidate(
  candidates: Map<string, RawImageCandidate>,
  candidate: RawImageCandidate,
  baseUrl: string,
): void {
  const url = toAbsoluteUrl(candidate.url, baseUrl);
  if (!url) return;

  const key = imageKey(url);
  const existing = candidates.get(key);
  if (!existing) {
    candidates.set(key, { ...candidate, url });
    return;
  }

  candidates.set(key, {
    ...existing,
    source: existing.source === "metadata" || existing.source === "defuddle" ? existing.source : candidate.source,
    alt: existing.alt ?? candidate.alt,
    caption: existing.caption ?? candidate.caption,
    width: Math.max(existing.width ?? 0, candidate.width ?? 0) || undefined,
    height: Math.max(existing.height ?? 0, candidate.height ?? 0) || undefined,
    context: [existing.context, candidate.context].filter(Boolean).join(" "),
  });
}

function metaContent(document: Document, selector: string): string | undefined {
  return cleanText(document.querySelector(selector)?.getAttribute("content"));
}

function addMetadataCandidates(
  document: Document,
  candidates: Map<string, RawImageCandidate>,
  baseUrl: string,
): void {
  const alt =
    metaContent(document, 'meta[property="og:image:alt"]') ??
    metaContent(document, 'meta[name="twitter:image:alt"]');
  const selectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ];

  for (const selector of selectors) {
    const url = metaContent(document, selector);
    if (url) {
      addCandidate(candidates, { url, source: "metadata", alt }, baseUrl);
    }
  }
}

function collectJsonLdImageValues(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || output.length > 30 || value == null) return;

  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdImageValues(item, output, depth + 1);
    return;
  }

  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  for (const key of ["url", "contentUrl", "@id"]) {
    if (typeof record[key] === "string") output.push(record[key] as string);
  }
}

function collectJsonLdImages(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || output.length > 30 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdImages(item, output, depth + 1);
    return;
  }

  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;

  for (const key of ["image", "thumbnail", "thumbnailUrl", "primaryImageOfPage"]) {
    collectJsonLdImageValues(record[key], output, depth + 1);
  }

  for (const value of Object.values(record)) {
    if (typeof value === "object") collectJsonLdImages(value, output, depth + 1);
  }
}

function addJsonLdCandidates(
  document: Document,
  candidates: Map<string, RawImageCandidate>,
  baseUrl: string,
): void {
  for (const script of Array.from(document.querySelectorAll('script[type*="ld+json"]'))) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const images: string[] = [];
      collectJsonLdImages(JSON.parse(raw), images);
      for (const url of images) {
        addCandidate(candidates, { url, source: "jsonld" }, baseUrl);
      }
    } catch {
      // Invalid JSON-LD is common and should not block extraction.
    }
  }
}

function nearbyContext(element: Element): string {
  const parts = [
    element.getAttribute("class"),
    element.getAttribute("id"),
    element.parentElement?.getAttribute("class"),
    element.closest("figure")?.getAttribute("class"),
    element.closest("aside, nav, header, footer")?.tagName,
  ];
  return parts.filter(Boolean).join(" ");
}

function addDomImageCandidates(
  document: Document,
  candidates: Map<string, RawImageCandidate>,
  baseUrl: string,
): void {
  const roots = Array.from(
    document.querySelectorAll(
      'article, main, [role="main"], .article, .article-content, .post-content, .entry-content',
    ),
  );
  const scopedRoots = roots.length > 0 ? roots : [document.body ?? document.documentElement];

  for (const root of scopedRoots) {
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const figure = img.closest("figure");
      const url = getImageUrl(img, baseUrl);
      if (!url) continue;

      addCandidate(
        candidates,
        {
          url,
          source: figure ? "figure" : "article",
          alt: cleanText(img.getAttribute("alt")),
          caption: cleanText(figure?.querySelector("figcaption")?.textContent),
          width: parseDimension(img.getAttribute("width") ?? img.getAttribute("data-width")),
          height: parseDimension(img.getAttribute("height") ?? img.getAttribute("data-height")),
          context: nearbyContext(img),
        },
        baseUrl,
      );
    }

    for (const source of Array.from(root.querySelectorAll("picture source"))) {
      const url = pickBestFromSrcset(source.getAttribute("srcset"), baseUrl);
      const image = source.parentElement?.querySelector("img");
      if (!url) continue;

      addCandidate(
        candidates,
        {
          url,
          source: "picture",
          alt: cleanText(image?.getAttribute("alt")),
          caption: cleanText(source.closest("figure")?.querySelector("figcaption")?.textContent),
          width: parseDimension(source.getAttribute("width") ?? image?.getAttribute("width") ?? null),
          height: parseDimension(source.getAttribute("height") ?? image?.getAttribute("height") ?? null),
          context: nearbyContext(source),
        },
        baseUrl,
      );
    }
  }
}

function scoreCandidate(candidate: RawImageCandidate): RankedImageCandidate {
  const searchable = [
    candidate.url,
    candidate.alt,
    candidate.caption,
    candidate.context,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const reasons: string[] = [candidate.source];
  let score = 0;

  if (candidate.source === "defuddle") score += 55;
  if (candidate.source === "metadata") score += 48;
  if (candidate.source === "jsonld") score += 38;
  if (candidate.source === "figure") score += 34;
  if (candidate.source === "picture") score += 30;
  if (candidate.source === "article") score += 24;

  if (candidate.caption) {
    score += 18;
    reasons.push("captioned");
  }
  if (candidate.alt && candidate.alt.length > 8) {
    score += 10;
    reasons.push("descriptive alt text");
  }

  const width = candidate.width ?? 0;
  const height = candidate.height ?? 0;
  if (width >= 1200) score += 18;
  else if (width >= 640) score += 12;
  if (height >= 400) score += 10;
  if (width > 0 && height > 0 && width * height < 40_000) score -= 45;

  if (/\b(hero|cover|featured|lead|main|article-image|opengraph|og:image)\b/.test(searchable)) {
    score += 12;
    reasons.push("article image signal");
  }
  if (/\b(logo|favicon|icon|sprite|avatar|profile|author|badge|share|social|tracking|pixel)\b/.test(searchable)) {
    score -= 55;
  }
  if (/\b(ad|ads|advert|banner|promo|sponsor|sidebar|nav|footer|header)\b/.test(searchable)) {
    score -= 35;
  }
  if (/\.(ico)(?:[?#]|$)/i.test(candidate.url)) score -= 80;
  if (/\.svg(?:[?#]|$)/i.test(candidate.url)) score -= 15;

  return {
    ...candidate,
    score,
    reason: reasons.join(", "),
  };
}

function rankedCandidates(
  result: DefuddleResponse,
  document: Document,
  baseUrl: string,
): RankedImageCandidate[] {
  const candidates = new Map<string, RawImageCandidate>();

  if (result.image) {
    addCandidate(candidates, { url: result.image, source: "defuddle" }, baseUrl);
  }
  addMetadataCandidates(document, candidates, baseUrl);
  addJsonLdCandidates(document, candidates, baseUrl);
  addDomImageCandidates(document, candidates, baseUrl);

  return [...candidates.values()]
    .map(scoreCandidate)
    .filter((candidate) => candidate.score >= 20)
    .sort((a, b) => b.score - a.score);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "webpage-image";
}

function imageCaption(candidate: RankedImageCandidate, title: string): string {
  const label = candidate.caption ?? candidate.alt ?? title ?? "Extracted webpage image";
  return truncate(label, 180);
}

async function downloadImages(
  candidates: RankedImageCandidate[],
  maxImages: number,
  title: string,
  warnings: string[],
): Promise<{ files: FileUploadResult[]; postedImages: PostedImage[] }> {
  const files: FileUploadResult[] = [];
  const postedImages: PostedImage[] = [];
  const baseName = slugify(title);

  for (const candidate of candidates.slice(0, IMAGE_VALIDATION_LIMIT)) {
    if (files.length >= maxImages) break;

    try {
      const fetched = await safeFetchBuffer(candidate.url, {
        maxBytes: MAX_IMAGE_BYTES,
        isAllowedContentType: isSupportedImageContentType,
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml;q=0.9,*/*;q=0.1" },
      });
      const mimeType = normalizeMimeType(fetched.contentType);
      const extension = IMAGE_MIME_TO_EXTENSION[mimeType];
      if (!extension) {
        warnings.push(`Skipped image with unsupported MIME type: ${candidate.url}`);
        continue;
      }

      const filename = `${baseName}-${files.length + 1}.${extension}`;
      files.push({
        _type: "file-upload",
        caption: imageCaption(candidate, title),
        filename,
        mimeType,
        dataBase64: fetched.buffer.toString("base64"),
      });
      postedImages.push({
        url: fetched.finalUrl,
        filename,
        mimeType,
        bytes: fetched.buffer.length,
        score: candidate.score,
        alt: candidate.alt,
        caption: candidate.caption,
        reason: candidate.reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped image ${candidate.url}: ${message}`);
    }
  }

  return { files, postedImages };
}

function formatImageList(images: PostedImage[], candidates: RankedImageCandidate[]): string {
  const posted = images.map(
    (image, index) =>
      `${index + 1}. ${image.filename} - ${image.caption ?? image.alt ?? image.url} (${image.mimeType}, ${(image.bytes / 1024).toFixed(1)} KB)`,
  );

  if (posted.length > 0) return `Images posted:\n${posted.join("\n")}`;

  const available = candidates.slice(0, 5).map(
    (candidate, index) =>
      `${index + 1}. ${candidate.url}${candidate.caption ? ` - ${candidate.caption}` : ""} (score ${candidate.score})`,
  );
  return available.length > 0
    ? `Image candidates found but not posted:\n${available.join("\n")}`
    : "No useful article images were found.";
}

function pageSummaryText({
  result,
  finalUrl,
  content,
  question,
  postedImages,
  candidates,
}: {
  result: DefuddleResponse;
  finalUrl: string;
  content: string;
  question?: string;
  postedImages: PostedImage[];
  candidates: RankedImageCandidate[];
}): string {
  const metadata = [
    `Title: ${result.title || "(untitled)"}`,
    result.site ? `Site: ${result.site}` : null,
    result.author ? `Author: ${result.author}` : null,
    result.published ? `Published: ${result.published}` : null,
    result.wordCount ? `Words: ${result.wordCount}` : null,
    `URL: ${finalUrl}`,
    question ? `User focus question: ${question}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `Extracted webpage content and assets.\n${metadata}`,
    formatImageList(postedImages, candidates),
    `Content for summarization:\n${truncate(content, MODEL_CONTENT_CHARS)}`,
  ].join("\n\n");
}

export const extractWebpageAssets = tool({
  description:
    "Extract readable article content and useful images from a specific webpage URL. " +
    "Use this when the user asks to summarize a link and include, show, pull, or extract images.",
  inputSchema: z.object({
    url: z.string().url().describe("The webpage URL to read."),
    question: z
      .string()
      .optional()
      .describe("Optional focus question to guide the final summary."),
    includeImages: z
      .boolean()
      .optional()
      .describe("Whether to download and post useful page images. Defaults to true."),
    maxImages: z
      .number()
      .min(0)
      .max(HARD_MAX_IMAGES)
      .optional()
      .describe("Maximum number of useful images to post. Defaults to 3, capped at 5."),
  }),
  execute: async ({
    url,
    question,
    includeImages = true,
    maxImages,
  }): Promise<RinaToolResult> => {
    const started = Date.now();
    const warnings: string[] = [];
    const imageLimit = includeImages ? clampMaxImages(maxImages) : 0;

    try {
      const page = await safeFetchBuffer(url, {
        maxBytes: MAX_HTML_BYTES,
        isAllowedContentType: isHtmlContentType,
        headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
      });
      const html = decodeResponseText(page.buffer, page.contentType);
      const { document } = parseHTML(html);
      const parsed = await parseReadablePage(document, page.finalUrl);

      const imageDocument = parseHTML(html).document;
      const candidates = includeImages
        ? rankedCandidates(parsed, imageDocument, page.finalUrl)
        : [];
      const { files, postedImages } =
        imageLimit > 0
          ? await downloadImages(candidates, imageLimit, parsed.title || new URL(page.finalUrl).hostname, warnings)
          : { files: [] as FileUploadResult[], postedImages: [] as PostedImage[] };

      if (includeImages && imageLimit > 0 && candidates.length > 0 && postedImages.length === 0) {
        warnings.push("Found image candidates, but none passed safety, MIME, or size validation.");
      }

      const content = extractedContent(parsed);
      const summary = pageSummaryText({
        result: parsed,
        finalUrl: page.finalUrl,
        content,
        question,
        postedImages,
        candidates,
      });

      return toolResult({
        ok: true,
        summary,
        data: {
          metadata: {
            title: parsed.title || undefined,
            description: parsed.description || undefined,
            author: parsed.author || undefined,
            published: parsed.published || undefined,
            site: parsed.site || undefined,
            domain: parsed.domain || undefined,
            wordCount: parsed.wordCount || undefined,
            finalUrl: page.finalUrl,
          },
          contentPreview: truncate(content, DATA_PREVIEW_CHARS),
          images: postedImages,
          imageCandidates: candidates.slice(0, 8).map((candidate) => ({
            url: candidate.url,
            score: candidate.score,
            source: candidate.source,
            alt: candidate.alt,
            caption: candidate.caption,
            reason: candidate.reason,
          })),
        },
        files: files.length > 0 ? files : undefined,
        citations: [{ title: parsed.title || undefined, url: page.finalUrl }],
        warnings: warnings.length > 0 ? warnings.slice(0, 6) : undefined,
        metrics: { elapsedMs: Date.now() - started },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolResult({
        ok: false,
        summary: `Failed to extract webpage assets from ${url}: ${message}`,
        citations: [{ url }],
        metrics: { elapsedMs: Date.now() - started },
      });
    }
  },
  toModelOutput: ({ output }) => ({
    type: "text" as const,
    value: toolResultToModelText(output),
  }),
});
