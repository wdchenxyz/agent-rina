import type { Adapter, Chat } from "chat";
import { isAccessAllowed } from "./access-control";
import { handleQuery } from "./agent";
import {
  buildPromptFromMessage,
  convertThreadHistory,
} from "./message-input";
import {
  buildDigestContextPrelude,
  getDigestThreadContext,
} from "../bot/news/context";
import {
  clearProcessingIndicator,
  isTelegramDirectMessage,
  markProcessingComplete,
  markProcessingStart,
} from "./platform-capabilities";
import type { BotThread, BotThreadState, IncomingMessage } from "./types";

type BotChat = Chat<Record<string, Adapter>, BotThreadState>;

async function runAssistant(
  thread: BotThread,
  message: IncomingMessage,
  opts: { prelude?: string; history?: import("ai").ModelMessage[] } = {},
): Promise<void> {
  const { content, warnings } = await buildPromptFromMessage(message);
  if (warnings.length > 0) {
    await thread.post({ markdown: warnings.map((w) => `> ${w}`).join("\n") });
  }
  await handleQuery(thread, content, opts);
}

async function handleFirstMessage(
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (!isAccessAllowed(thread, message)) return;

  await thread.subscribe();
  await markProcessingStart(thread, message);

  let success = false;
  try {
    await runAssistant(thread, message);
    success = true;
  } catch (error) {
    console.error(
      `[rina] Failed to handle first message in ${thread.id}`,
      error,
    );
    try {
      await thread.post({
        markdown:
          "I hit an internal error while generating a reply. Please try again.",
      });
    } catch {
      // Ignore secondary failures
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
  bot: BotChat,
  thread: BotThread,
  message: IncomingMessage,
): Promise<void> {
  if (message.author.isMe) return;
  if (!isAccessAllowed(thread, message)) return;

  await markProcessingStart(thread, message);

  // Fetch thread history and digest context in parallel
  const [history, digestContext] = await Promise.all([
    convertThreadHistory(thread, message.id),
    getDigestThreadContext(bot.getState(), thread.id),
  ]);
  const prelude = digestContext
    ? buildDigestContextPrelude(digestContext)
    : undefined;

  let success = false;
  try {
    await runAssistant(thread, message, { prelude, history });
    success = true;
  } catch (error) {
    console.error(
      `[rina] Failed to handle subscribed message in ${thread.id}`,
      error,
    );
    try {
      await thread.post({
        markdown:
          "I hit an internal error while generating a reply. Please try again.",
      });
    } catch {
      // Ignore secondary failures
    }
  } finally {
    if (success) {
      await markProcessingComplete(thread, message);
    } else {
      await clearProcessingIndicator(thread, message);
    }
  }
}

export function registerHandlers(bot: BotChat): void {
  bot.onNewMention(async (thread, message) => {
    await handleFirstMessage(thread, message);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    await handleSubscribedMessage(bot, thread, message);
  });

  // Catch-all for Telegram DMs (they don't have @mentions)
  bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
    if (!isTelegramDirectMessage(thread)) return;
    await handleFirstMessage(thread, message);
  });
}
