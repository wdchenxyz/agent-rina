import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { tool } from "ai";
import { z } from "zod";

import type { BotThread } from "../types";

const execFileAsync = promisify(execFile);

const PAPERS_DIR = path.resolve("artifacts/papers");
const MAX_FILE_BYTES = 100 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB per file (Slack limit)
const USER_AGENT =
  "Mozilla/5.0 (compatible; RinaPaperBot/1.0; +https://github.com)";

// --- Helpers ---

function normalizeArxivId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^\s/?#]+)/i.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  if (/^[\d.]+(?:v\d+)?$/.test(trimmed)) return trimmed;
  return trimmed;
}

function paperDir(paperId: string): string {
  return path.join(PAPERS_DIR, paperId);
}

function guardPath(paperId: string, filePath: string): string {
  const base = paperDir(paperId);
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

async function recursiveList(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await recursiveList(full)));
    } else {
      results.push(full);
    }
  }
  return results;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "svg",
  "pdf",
  "eps",
]);

/** Extensions uploadable to chat (inline images + document attachments). */
const UPLOADABLE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};



// --- Tools ---

export function createArxivTools(thread: BotThread) {
  const downloadArxivSource = tool({
    description:
      "Download and extract LaTeX source files from an arxiv paper. Accepts a paper ID (e.g. 1706.03762) or full arxiv URL.",
    inputSchema: z.object({
      paper_id_or_url: z.string().describe("Arxiv paper ID or URL"),
    }),
    execute: async ({ paper_id_or_url }) => {
      const paperId = normalizeArxivId(paper_id_or_url);
      const dir = paperDir(paperId);

      // Skip if already extracted
      try {
        const existing = await fs.readdir(dir);
        if (existing.length > 0) {
          return `Source already extracted at ${dir} (${existing.length} items). Use listPaperFiles to see contents.`;
        }
      } catch {
        // Does not exist yet
      }

      await fs.mkdir(dir, { recursive: true });

      const srcUrl = `https://arxiv.org/src/${paperId}`;
      const response = await fetch(srcUrl, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });

      if (response.status === 404) {
        await fs.rm(dir, { recursive: true, force: true });
        return `Paper ${paperId} not found on arxiv. Check the ID and try again.`;
      }
      if (response.status === 429) {
        await fs.rm(dir, { recursive: true, force: true });
        return "Rate limited by arxiv. Please wait a moment and try again.";
      }
      if (!response.ok) {
        await fs.rm(dir, { recursive: true, force: true });
        return `Failed to download source: HTTP ${response.status}`;
      }

      const contentType = response.headers.get("content-type") || "";
      const buffer = Buffer.from(await response.arrayBuffer());

      if (contentType.includes("pdf")) {
        await fs.rm(dir, { recursive: true, force: true });
        return `Paper ${paperId} only has PDF available (no LaTeX source). Try fetching https://arxiv.org/abs/${paperId} instead.`;
      }

      const archivePath = path.join(dir, "__source_archive");
      await fs.writeFile(archivePath, buffer);

      try {
        // Try tar.gz first (most common)
        await execFileAsync("tar", ["-xzf", archivePath, "-C", dir]);
      } catch {
        try {
          // Try plain gzip (single .tex file)
          await execFileAsync("gunzip", ["-f", archivePath]);
          const files = await fs.readdir(dir);
          const remaining = files.filter((f) => f !== "__source_archive");
          if (remaining.length === 1 && !remaining[0].endsWith(".tex")) {
            await fs.rename(
              path.join(dir, remaining[0]),
              path.join(dir, "main.tex"),
            );
          }
        } catch {
          await fs.rm(dir, { recursive: true, force: true });
          return `Failed to extract source archive. Content-Type was: ${contentType}`;
        }
      }

      // Clean up archive file
      await fs.rm(archivePath, { force: true });

      const files = await fs.readdir(dir);
      return `Downloaded and extracted source for ${paperId} (${files.length} items). Use listPaperFiles to see the full file listing.`;
    },
  });

  const listPaperFiles = tool({
    description:
      "List all files in an extracted arxiv paper source, categorized by type.",
    inputSchema: z.object({
      paper_id: z.string().describe("Arxiv paper ID"),
    }),
    execute: async ({ paper_id }) => {
      const dir = paperDir(paper_id);

      try {
        await fs.access(dir);
      } catch {
        return `No source found for ${paper_id}. Use downloadArxivSource first.`;
      }

      const allFiles = await recursiveList(dir);
      const relative = allFiles.map((f) => path.relative(dir, f));

      const tex: string[] = [];
      const bib: string[] = [];
      const images: string[] = [];
      const other: string[] = [];

      for (const file of relative) {
        const ext = path.extname(file).slice(1).toLowerCase();
        if (ext === "tex") tex.push(file);
        else if (ext === "bib" || ext === "bbl") bib.push(file);
        else if (IMAGE_EXTENSIONS.has(ext)) images.push(file);
        else other.push(file);
      }

      const sections = [
        tex.length > 0 ? `TeX files:\n${tex.join("\n")}` : null,
        bib.length > 0 ? `Bibliography:\n${bib.join("\n")}` : null,
        images.length > 0 ? `Images:\n${images.join("\n")}` : null,
        other.length > 0 ? `Other:\n${other.join("\n")}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      return sections || "No files found.";
    },
  });

  const readPaperFile = tool({
    description: "Read a text file from an extracted arxiv paper source.",
    inputSchema: z.object({
      paper_id: z.string().describe("Arxiv paper ID"),
      file_path: z
        .string()
        .describe("Relative path within the paper directory"),
    }),
    execute: async ({ paper_id, file_path }) => {
      let resolved: string;
      try {
        resolved = guardPath(paper_id, file_path);
      } catch {
        return "Invalid file path.";
      }

      try {
        await fs.access(resolved);
      } catch {
        return `File not found: ${file_path}`;
      }

      const stat = await fs.stat(resolved);
      let content = await fs.readFile(resolved, "utf-8");
      let truncated = false;

      if (stat.size > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES);
        truncated = true;
      }

      const suffix = truncated
        ? `\n\n[Truncated — file is ${stat.size} bytes, showing first ${MAX_FILE_BYTES} bytes]`
        : "";

      return content + suffix;
    },
  });

  const uploadPaperFigure = tool({
    description:
      "Upload a single figure from an extracted arxiv paper to the chat. " +
      "Supports images (png, jpg, gif, webp) and PDF figures. " +
      "Call this contextually while summarizing — e.g. upload the architecture diagram " +
      "when discussing the method, upload result plots when discussing experiments.",
    inputSchema: z.object({
      paper_id: z.string().describe("Arxiv paper ID"),
      file_path: z
        .string()
        .describe("Relative path to the figure within the paper directory"),
      caption: z
        .string()
        .optional()
        .describe("Caption to display with the figure"),
    }),
    execute: async ({ paper_id, file_path, caption }) => {
      let resolved: string;
      try {
        resolved = guardPath(paper_id, file_path);
      } catch {
        return "Invalid file path.";
      }

      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mimeType = UPLOADABLE_EXTENSIONS[ext];

      if (!mimeType) {
        return `Unsupported figure format: .${ext}. Supported: png, jpg, gif, webp, pdf.`;
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolved);
      } catch {
        return `File not found: ${file_path}`;
      }

      if (stat.size > MAX_UPLOAD_BYTES) {
        return `File too large (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Max is 8 MB.`;
      }

      const data = await fs.readFile(resolved);
      const filename = path.basename(file_path);

      await thread.post({
        markdown: caption || "",
        files: [{ data, filename, mimeType }],
      });

      return `Uploaded ${filename} to chat.`;
    },
  });

  return {
    downloadArxivSource,
    listPaperFiles,
    readPaperFile,
    uploadPaperFigure,
  };
}
