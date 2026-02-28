import { readFile } from "fs/promises";
import path from "path";
import type { Adapter, Chat } from "chat";
import { isAccessAllowed } from "./access-control";
import { handleQuery } from "./agent-runtime";
import { buildPromptFromMessage } from "./message-input";
import {
  clearProcessingIndicator,
  isTelegramDirectMessage,
  markProcessingComplete,
  markProcessingStart,
} from "./platform-capabilities";
import type { BotThread, BotThreadState, IncomingMessage } from "./types";

type BotChat = Chat<Record<string, Adapter>, BotThreadState>;

const TRIGGER_KEYWORD = "/testimage";

async function handleTriggerCommand(thread: BotThread, message: IncomingMessage): Promise<boolean> {
  // Strip leading @mention (e.g. "@BotName /testimage" → "/testimage")
  const text = message.text?.trim().replace(/^@\S+\s*/, "").trim().toLowerCase();
  if (text !== TRIGGER_KEYWORD) return false;

  const imagePath = path.join(process.cwd(), "artifacts", "image.png");
  const data = await readFile(imagePath);
  await thread.post({
    markdown: "Here's your test image!",
    files: [{ data: Buffer.from(data), filename: "image.png", mimeType: "image/png" }],
  });
  return true;
}

function isClaudeProcessExitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = error.message.toLowerCase();
  return (
    text.includes("claude code process exited with code") ||
    text.includes("failed to spawn claude code process")
  );
}

async function runAssistant(
  thread: BotThread,
  message: IncomingMessage,
  opts: { resume?: string } = {},
): Promise<void> {
  const { prompt, warnings } = await buildPromptFromMessage(message);
  if (warnings.length > 0) {
    await thread.post(warnings.map((warning) => `> ${warning}`).join("\n"));
  }

  const sessionId = await handleQuery(thread, prompt, opts);
  if (sessionId) {
    await thread.setState({ sdkSessionId: sessionId });
  }
}

async function runAssistantWithResumeFallback(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  const state = await thread.state;
  const resume = state?.sdkSessionId;

  if (!resume) {
    await runAssistant(thread, message);
    return;
  }

  try {
    await runAssistant(thread, message, { resume });
  } catch (error) {
    if (!isClaudeProcessExitError(error)) {
      throw error;
    }

    console.error(
      `[assistant] Resume failed for thread ${thread.id}, falling back to a fresh session.`,
      error,
    );

    await thread.setState({}, { replace: true });
    await thread.post(
      "> I couldn't resume the previous session context, so I started a new one.",
    );
    await runAssistant(thread, message);
  }
}

async function handleFirstMessage(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (!isAccessAllowed(thread, message)) return;
  if (await handleTriggerCommand(thread, message)) return;

  await thread.subscribe();
  await markProcessingStart(thread, message);

  let success = false;
  try {
    await runAssistant(thread, message);
    success = true;
  } catch (error) {
    console.error(`[assistant] Failed to handle first message in ${thread.id}`, error);
    try {
      await thread.post(
        "I hit an internal error while generating a reply. Please try again.",
      );
    } catch {
      // Ignore secondary failures.
    }
  } finally {
    if (success) {
      await markProcessingComplete(thread, message);
    } else {
      await clearProcessingIndicator(thread, message);
    }
  }
}

async function handleSubscribedMessage(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (message.author.isMe) return;
  if (!isAccessAllowed(thread, message)) return;
  if (await handleTriggerCommand(thread, message)) return;

  await markProcessingStart(thread, message);

  let success = false;
  try {
    await runAssistantWithResumeFallback(thread, message);
    success = true;
  } catch (error) {
    console.error(
      `[assistant] Failed to handle subscribed message in ${thread.id}`,
      error,
    );
    try {
      await thread.post(
        "I hit an internal error while generating a reply. Please try again.",
      );
    } catch {
      // Ignore secondary failures.
    }
  } finally {
    if (success) {
      await markProcessingComplete(thread, message);
    } else {
      await clearProcessingIndicator(thread, message);
    }
  }
}

export function registerBotHandlers(bot: BotChat): void {
  bot.onNewMention(async (thread, message) => {
    await handleFirstMessage(thread, message);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    await handleSubscribedMessage(thread, message);
  });

  bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
    if (!isTelegramDirectMessage(thread)) return;
    await handleFirstMessage(thread, message);
  });
}
