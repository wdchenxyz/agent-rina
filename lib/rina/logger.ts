import fs from "node:fs/promises";
import path from "node:path";

import type { ModelMessage, UserContent } from "ai";
import type { IncomingMessage } from "./types";

const LOGS_DIR = path.resolve("logs/threads");
const MAX_TOOL_OUTPUT_CHARS = 2048;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString();
}

function truncate(text: string | undefined | null, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (!text) return "(empty)";
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} chars total)`;
}

/** One-line summary of a UserContent value (string or part array). */
function summarizeContent(content: UserContent): string {
  if (typeof content === "string") {
    return `"${content.slice(0, 120)}${content.length > 120 ? "..." : ""}"`;
  }
  if (!Array.isArray(content)) return "(unknown)";
  const texts = content.filter((p) => p.type === "text").length;
  const images = content.filter((p) => p.type === "image").length;
  const files = content.filter((p) => p.type === "file").length;
  const parts: string[] = [];
  if (texts > 0) {
    const first = content.find((p) => p.type === "text");
    const preview =
      first && "text" in first
        ? `"${(first.text as string).slice(0, 100)}${(first.text as string).length > 100 ? "..." : ""}"`
        : "";
    parts.push(`${texts} text ${preview}`);
  }
  if (images > 0) parts.push(`${images} image`);
  if (files > 0) parts.push(`${files} file`);
  return parts.join(" + ");
}

function formatAttachmentInfo(
  att: IncomingMessage["attachments"][number],
): string {
  const size = att.data instanceof Buffer ? att.data.length : null;
  const sizeStr = size ? ` ${(size / 1024).toFixed(1)}KB` : "";
  return `${att.name ?? "unnamed"} (${att.mimeType ?? "unknown"}${sizeStr})`;
}

// ---------------------------------------------------------------------------
// ThreadLogger
// ---------------------------------------------------------------------------

export class ThreadLogger {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(platform: string, threadId: string) {
    // Sanitize thread ID for filesystem safety
    const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.filePath = path.join(LOGS_DIR, `${platform}_${safe}.log`);
  }

  // -- Internal writer (serialized to avoid interleaved appends) --

  private append(text: string): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, text);
      })
      .catch((err) => {
        console.error(`[rina:logger] Failed to write log: ${err}`);
      });
  }

  /** Wait for all pending writes to flush. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  // -- Public log methods --

  logSeparator(messageId: string): void {
    this.append(
      [
        "",
        "========================================",
        `  ${ts()} | ${messageId}`,
        "========================================",
        "",
      ].join("\n"),
    );
  }

  logIncoming(message: IncomingMessage): void {
    const attachments = message.attachments ?? [];
    const attInfo =
      attachments.length > 0
        ? attachments.map(formatAttachmentInfo).join(", ")
        : "none";

    this.append(
      [
        ">> Incoming",
        `Author: ${message.author.userId ?? "unknown"}`,
        `Text: ${message.text?.slice(0, 500) ?? "(empty)"}`,
        `Attachments: ${attachments.length} [${attInfo}]`,
        "",
      ].join("\n"),
    );
  }

  logHistory(history: ModelMessage[]): void {
    if (history.length === 0) {
      this.append(">> History (empty)\n\n");
      return;
    }

    const lines = [`>> History (${history.length} messages)`];
    for (const msg of history) {
      const summary =
        typeof msg.content === "string"
          ? `"${msg.content.slice(0, 120)}${msg.content.length > 120 ? "..." : ""}"`
          : summarizeContent(msg.content as UserContent);
      lines.push(`[${msg.role}] ${summary}`);
    }
    lines.push("");
    this.append(lines.join("\n"));
  }

  logPrompt(messages: ModelMessage[]): void {
    const lines = [`>> Prompt to Agent (${messages.length} messages)`];
    for (const [i, msg] of messages.entries()) {
      const summary =
        typeof msg.content === "string"
          ? `"${msg.content.slice(0, 200)}${msg.content.length > 200 ? "..." : ""}"`
          : summarizeContent(msg.content as UserContent);
      lines.push(`[${i}] role=${msg.role} | ${summary}`);
    }
    lines.push("");
    this.append(lines.join("\n"));
  }

  logToolCall(toolName: string, input: string): void {
    this.append(
      [
        `>> Tool: ${toolName} [${ts()}]`,
        `Input:  ${truncate(input)}`,
        "",
      ].join("\n"),
    );
  }

  logToolResult(toolName: string, output: string): void {
    this.append(
      [
        `Output: ${truncate(output)}`,
        `        (${output.length} chars)`,
        "",
      ].join("\n"),
    );
  }

  logResponse(text: string): void {
    this.append([`>> Response [${ts()}]`, text, ""].join("\n"));
  }
}
