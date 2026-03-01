import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { BotThread } from "../types";

const ARTIFACTS_DIR = path.resolve("artifacts");
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB (Slack limit)

const ALLOWED_EXTENSIONS: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Documents
  pdf: "application/pdf",
  // Data
  csv: "text/csv",
  json: "application/json",
};

const SUPPORTED_LIST = Object.keys(ALLOWED_EXTENSIONS).join(", ");

/**
 * Resolve a user-provided path relative to ARTIFACTS_DIR and guard against
 * path traversal. Returns the absolute path or throws.
 */
function guardPath(filePath: string): string {
  const resolved = path.resolve(ARTIFACTS_DIR, filePath);
  if (!resolved.startsWith(ARTIFACTS_DIR + path.sep) && resolved !== ARTIFACTS_DIR) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

/**
 * Creates tools for uploading files from the artifacts/ directory to chat.
 */
export function createArtifactTools(thread: BotThread) {
  const uploadArtifact = tool({
    description:
      "Upload a file from the artifacts/ directory to the chat. " +
      `Supported formats: ${SUPPORTED_LIST}. Max size: 8 MB.`,
    inputSchema: z.object({
      path: z
        .string()
        .describe("File path relative to artifacts/, e.g. 'image.png' or 'charts/plot.png'"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption to display with the file"),
    }),
    execute: async ({ path: artifactPath, caption }) => {
      let resolved: string;
      try {
        resolved = guardPath(artifactPath);
      } catch {
        return "Invalid file path — must be inside artifacts/.";
      }

      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mimeType = ALLOWED_EXTENSIONS[ext];

      if (!mimeType) {
        return `Unsupported file format: .${ext}. Supported: ${SUPPORTED_LIST}.`;
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolved);
      } catch {
        return `File not found: ${artifactPath}`;
      }

      if (stat.size > MAX_UPLOAD_BYTES) {
        return `File too large (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Max is 8 MB.`;
      }

      const data = await fs.readFile(resolved);
      const filename = path.basename(artifactPath);

      await thread.post({
        markdown: caption || "",
        files: [{ data, filename, mimeType }],
      });

      return `Uploaded ${filename} to chat.`;
    },
  });

  return { uploadArtifact };
}
