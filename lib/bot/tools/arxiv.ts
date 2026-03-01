import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { IMAGE_EXT_TO_MIME } from "../constants";
import type { BotThread } from "../types";

const execFileAsync = promisify(execFile);

const PAPERS_DIR = path.resolve("artifacts/papers");
const MAX_FILE_BYTES = 100 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const USER_AGENT =
  "Mozilla/5.0 (compatible; RinaPaperBot/1.0; +https://github.com)";

const FIGURE_MIME: Record<string, string> = {
  ...IMAGE_EXT_TO_MIME,
  pdf: "application/pdf",
  eps: "application/postscript",
};

function normalizeArxivId(input: string): string {
  const trimmed = input.trim();
  // Full URL: https://arxiv.org/abs/1706.03762 or /pdf/1706.03762
  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^\s/?#]+)/i.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  // Plain ID: 1706.03762 or 1706.03762v1
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

export function createArxivTools(thread: BotThread) {
  const downloadArxivSource = tool(
    "download_arxiv_source",
    "Download and extract LaTeX source files from an arxiv paper. Accepts a paper ID (e.g. 1706.03762) or full arxiv URL.",
    { paper_id_or_url: z.string().describe("Arxiv paper ID or URL") },
    async ({ paper_id_or_url }) => {
      const paperId = normalizeArxivId(paper_id_or_url);
      const dir = paperDir(paperId);

      // Skip if already extracted
      try {
        const existing = await fs.readdir(dir);
        if (existing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Source already extracted at ${dir} (${existing.length} items). Use list_paper_files to see contents.`,
              },
            ],
          };
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
        await fs.rmdir(dir).catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text: `Paper ${paperId} not found on arxiv. Check the ID and try again.`,
            },
          ],
        };
      }

      if (response.status === 429) {
        await fs.rmdir(dir).catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text: "Rate limited by arxiv. Please wait a moment and try again.",
            },
          ],
        };
      }

      if (!response.ok) {
        await fs.rmdir(dir).catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to download source: HTTP ${response.status}`,
            },
          ],
        };
      }

      const contentType = response.headers.get("content-type") || "";
      const buffer = Buffer.from(await response.arrayBuffer());

      if (contentType.includes("pdf")) {
        await fs.rmdir(dir).catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text: `Paper ${paperId} only has PDF available (no LaTeX source). Try using WebFetch on https://arxiv.org/abs/${paperId} to read the abstract instead.`,
            },
          ],
        };
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
          // gunzip removes the file and creates one without extension
          // Rename to .tex if it's a single file
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
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to extract source archive. Content-Type was: ${contentType}`,
              },
            ],
          };
        }
      }

      // Clean up archive file
      await fs.rm(archivePath, { force: true });

      const files = await fs.readdir(dir);
      return {
        content: [
          {
            type: "text" as const,
            text: `Downloaded and extracted source for ${paperId} (${files.length} items). Use list_paper_files to see the full file listing.`,
          },
        ],
      };
    },
  );

  const listPaperFiles = tool(
    "list_paper_files",
    "List all files in an extracted arxiv paper source, categorized by type.",
    { paper_id: z.string().describe("Arxiv paper ID") },
    async ({ paper_id }) => {
      const dir = paperDir(paper_id);

      try {
        await fs.access(dir);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `No source found for ${paper_id}. Use download_arxiv_source first.`,
            },
          ],
        };
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
        else if (ext in IMAGE_EXT_TO_MIME || ext === "pdf" || ext === "eps")
          images.push(file);
        else other.push(file);
      }

      const sections = [
        tex.length > 0 ? `**TeX files:**\n${tex.join("\n")}` : null,
        bib.length > 0 ? `**Bibliography:**\n${bib.join("\n")}` : null,
        images.length > 0 ? `**Images:**\n${images.join("\n")}` : null,
        other.length > 0 ? `**Other:**\n${other.join("\n")}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: sections || "No files found." }],
      };
    },
  );

  const readPaperFile = tool(
    "read_paper_file",
    "Read a text file from an extracted arxiv paper source.",
    {
      paper_id: z.string().describe("Arxiv paper ID"),
      file_path: z.string().describe("Relative path within the paper directory"),
    },
    async ({ paper_id, file_path }) => {
      let resolved: string;
      try {
        resolved = guardPath(paper_id, file_path);
      } catch {
        return {
          content: [
            { type: "text" as const, text: "Invalid file path." },
          ],
        };
      }

      try {
        await fs.access(resolved);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `File not found: ${file_path}`,
            },
          ],
        };
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

      return {
        content: [{ type: "text" as const, text: content + suffix }],
      };
    },
  );

  const uploadPaperFigure = tool(
    "upload_paper_figure",
    "Upload a figure from an extracted arxiv paper to the chat. Supports images (PNG, JPG, GIF, WebP, BMP, TIFF, SVG) and document figures (PDF, EPS).",
    {
      paper_id: z.string().describe("Arxiv paper ID"),
      file_path: z
        .string()
        .describe("Relative path to the figure within the paper directory"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption for the figure"),
    },
    async ({ paper_id, file_path, caption }) => {
      let resolved: string;
      try {
        resolved = guardPath(paper_id, file_path);
      } catch {
        return {
          content: [
            { type: "text" as const, text: "Invalid file path." },
          ],
        };
      }

      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mimeType = FIGURE_MIME[ext];

      if (!mimeType) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsupported figure format: .${ext}`,
            },
          ],
        };
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolved);
      } catch {
        return {
          content: [
            { type: "text" as const, text: `File not found: ${file_path}` },
          ],
        };
      }

      if (stat.size > MAX_UPLOAD_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `File too large (${(stat.size / (1024 * 1024)).toFixed(1)}MB). Max is 8MB.`,
            },
          ],
        };
      }

      const data = await fs.readFile(resolved);
      const filename = path.basename(file_path);

      await thread.post({
        files: [{ data, filename, mimeType }],
        markdown: caption || `Figure: ${filename}`,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Uploaded figure ${filename} to chat.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "arxiv",
    version: "1.0.0",
    tools: [
      downloadArxivSource,
      listPaperFiles,
      readPaperFile,
      uploadPaperFigure,
    ],
  });
}
