import { emoji } from "chat";
import type { BotThread, IncomingMessage } from "./types";

function isSlackThread(thread: BotThread): boolean {
  return thread.adapter.name === "slack";
}

export function isTelegramDirectMessage(thread: BotThread): boolean {
  return thread.adapter.name === "telegram" && thread.isDM;
}

export async function markProcessingStart(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (!isSlackThread(thread)) return;

  try {
    await thread.adapter.addReaction(message.threadId, message.id, emoji.eyes);
  } catch {
    // Reactions are best-effort.
  }
}

export async function markProcessingComplete(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (!isSlackThread(thread)) return;

  try {
    await thread.adapter.removeReaction(message.threadId, message.id, emoji.eyes);
  } catch {
    // Reactions are best-effort.
  }

  try {
    await thread.adapter.addReaction(message.threadId, message.id, emoji.check);
  } catch {
    // Reactions are best-effort.
  }
}

export async function clearProcessingIndicator(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (!isSlackThread(thread)) return;

  try {
    await thread.adapter.removeReaction(message.threadId, message.id, emoji.eyes);
  } catch {
    // Reactions are best-effort.
  }
}
