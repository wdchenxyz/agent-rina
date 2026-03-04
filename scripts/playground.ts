/**
 * CLI playground for interacting with the Rina agent directly.
 * Bypasses Slack/Telegram — calls handleQuery with a mock BotThread.
 *
 * Usage:
 *   pnpm pg                  # interactive REPL
 *   pnpm pg "your question"  # single-shot mode
 */

import "dotenv/config";
import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";

import type { ModelMessage, UserContent } from "ai";
import { handleQuery } from "../lib/rina/agent";
import type { BotThread } from "../lib/rina/types";

// ---------------------------------------------------------------------------
// Colors (ANSI)
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Mock BotThread — minimal implementation for handleQuery
// ---------------------------------------------------------------------------

function createCliThread(): BotThread {
  const thread = {
    adapter: { name: "cli" },

    /**
     * post() handles three call signatures used by handleQuery + tools:
     *  1. { markdown: string, files?: ... }  — text message (optionally with files)
     *  2. AsyncIterable<string>              — streaming text chunks
     *  3. string                             — plain string
     */
    async post(
      message:
        | string
        | { markdown?: string; files?: Array<{ filename: string; data: Buffer | Blob | ArrayBuffer }> }
        | AsyncIterable<string>,
    ): Promise<{ id: string }> {
      // Streaming text chunks
      if (message !== null && typeof message === "object" && Symbol.asyncIterator in message) {
        for await (const chunk of message as AsyncIterable<string>) {
          process.stdout.write(chunk);
        }
        process.stdout.write("\n");
        return { id: "stream" };
      }

      // Plain string
      if (typeof message === "string") {
        console.log(message);
        return { id: "text" };
      }

      // Object with markdown and/or files
      const obj = message as {
        markdown?: string;
        files?: Array<{ filename: string; data: Buffer | Blob | ArrayBuffer }>;
      };

      if (obj.markdown) {
        // Dim status messages ("> Searching...", etc.)
        if (obj.markdown.startsWith("> ")) {
          process.stderr.write(`${DIM}${obj.markdown}${RESET}\n`);
        } else {
          console.log(obj.markdown);
        }
      }

      if (obj.files?.length) {
        const outDir = path.resolve("artifacts");
        fs.mkdirSync(outDir, { recursive: true });
        for (const file of obj.files) {
          const dest = path.join(outDir, file.filename);
          const buf = file.data instanceof Buffer
            ? file.data
            : Buffer.from(file.data instanceof ArrayBuffer ? file.data : await (file.data as Blob).arrayBuffer());
          fs.writeFileSync(dest, buf);
          console.log(`${DIM}[file saved: ${dest}]${RESET}`);
        }
      }

      return { id: "msg" };
    },
  };

  // Cast — we only implement the subset handleQuery actually uses
  return thread as unknown as BotThread;
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

const history: ModelMessage[] = [];

function addUserMessage(text: string): void {
  history.push({ role: "user", content: `[user: @playground (CLI)] ${text}` });
}

function addAssistantMessage(text: string): void {
  if (text.trim()) {
    history.push({ role: "assistant", content: text });
  }
}

// ---------------------------------------------------------------------------
// Capture assistant response from the stream
// ---------------------------------------------------------------------------

function createCapturingThread(base: BotThread): { thread: BotThread; getResponse: () => string } {
  const chunks: string[] = [];

  const thread = {
    ...base,
    async post(
      message:
        | string
        | { markdown?: string; files?: Array<{ filename: string; data: Buffer | Blob | ArrayBuffer }> }
        | AsyncIterable<string>,
    ): Promise<{ id: string }> {
      // Capture streamed text for history
      if (message !== null && typeof message === "object" && Symbol.asyncIterator in message) {
        const passthrough = async function* () {
          for await (const chunk of message as AsyncIterable<string>) {
            chunks.push(chunk);
            yield chunk;
          }
        };
        return base.post(passthrough() as unknown as AsyncIterable<string>);
      }

      // Capture non-status markdown for history
      if (typeof message === "object" && "markdown" in message) {
        const md = (message as { markdown?: string }).markdown;
        if (md && !md.startsWith("> ")) {
          chunks.push(md);
        }
      }

      return base.post(message as Parameters<typeof base.post>[0]);
    },
  } as unknown as BotThread;

  return { thread, getResponse: () => chunks.join("") };
}

// ---------------------------------------------------------------------------
// Run a single query
// ---------------------------------------------------------------------------

async function runQuery(text: string): Promise<void> {
  addUserMessage(text);

  const baseThread = createCliThread();
  const { thread, getResponse } = createCapturingThread(baseThread);

  const pastHistory = history.slice(0, -1); // exclude current message

  try {
    await handleQuery(thread, `[user: @playground (CLI)] ${text}`, {
      history: pastHistory.length > 0 ? pastHistory : undefined,
    });
  } catch (err) {
    console.error(`${YELLOW}[error]${RESET}`, err instanceof Error ? err.message : err);
  }

  addAssistantMessage(getResponse());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`${GREEN}Rina Playground${RESET} ${DIM}(type /quit to exit, /clear to reset history)${RESET}\n`);

  // Single-shot mode: pnpm pg "question"
  const inlineQuery = process.argv.slice(2).join(" ").trim();
  if (inlineQuery) {
    await runQuery(inlineQuery);
    return;
  }

  // Interactive REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts go to stderr so stdout is clean agent output
    prompt: `${CYAN}you> ${RESET}`,
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      console.log(`${DIM}bye${RESET}`);
      rl.close();
      process.exit(0);
    }

    if (input === "/clear") {
      history.length = 0;
      console.log(`${DIM}[history cleared]${RESET}`);
      rl.prompt();
      return;
    }

    if (input === "/history") {
      if (history.length === 0) {
        console.log(`${DIM}[no history]${RESET}`);
      } else {
        for (const msg of history) {
          const preview = typeof msg.content === "string"
            ? msg.content.slice(0, 120)
            : "(multipart)";
          console.log(`${DIM}[${msg.role}]${RESET} ${preview}`);
        }
      }
      rl.prompt();
      return;
    }

    await runQuery(input);
    console.log(); // blank line between turns
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
