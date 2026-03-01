import { emoji } from "chat";
import type { BotThread, IncomingMessage } from "./types";

export function isTelegramDirectMessage(thread: BotThread): boolean {
  return thread.adapter.name === "telegram" && thread.isDM;
}

export async function markProcessingStart(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (thread.adapter.name !== "slack") return;
  try {
    await thread.adapter.addReaction(message.threadId, message.id, emoji.eyes);
  } catch {
    // Best-effort
  }
}

export async function markProcessingComplete(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (thread.adapter.name !== "slack") return;
  try {
    await thread.adapter.removeReaction(
      message.threadId,
      message.id,
      emoji.eyes,
    );
  } catch {
    // Best-effort
  }
  try {
    await thread.adapter.addReaction(
      message.threadId,
      message.id,
      emoji.check,
    );
  } catch {
    // Best-effort
  }
}

export async function clearProcessingIndicator(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (thread.adapter.name !== "slack") return;
  try {
    await thread.adapter.removeReaction(
      message.threadId,
      message.id,
      emoji.eyes,
    );
  } catch {
    // Best-effort
  }
}
