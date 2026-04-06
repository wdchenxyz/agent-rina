import type { ModelMessage } from "ai";
import type { Adapter, Chat } from "chat";
import { isAccessAllowed } from "./access-control";
import { runAgent } from "./agent";
import { deliverToChat } from "./delivery";
import { ThreadLogger } from "./logger";
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
type AssistantRunOptions = {
  prelude?: string;
  history?: ModelMessage[];
  logger?: ThreadLogger;
};
type AssistantRunSetup = (
  logger: ThreadLogger,
) => Promise<AssistantRunOptions> | AssistantRunOptions;

/**
 * Slack's `app_mention` events don't include file attachments, but often win
 * the dedup race against the `message` event (which does include files).
 * When the incoming message has no attachments, re-fetch it from the platform
 * to pick up any files that were dropped.
 */
async function ensureAttachments(
  thread: BotThread,
  message: IncomingMessage,
): Promise<IncomingMessage> {
  if (message.attachments && message.attachments.length > 0) {
    return message;
  }

  try {
    const fetched = await thread.adapter.fetchMessage?.(thread.id, message.id);
    if (fetched && fetched.attachments && fetched.attachments.length > 0) {
      console.log(
        `[rina] Re-fetched message ${message.id}: found ${fetched.attachments.length} attachment(s) missing from original event`,
      );
      return fetched as IncomingMessage;
    }
  } catch (err) {
    console.warn(`[rina] Failed to re-fetch message ${message.id}:`, err);
  }

  return message;
}

async function runAssistant(
  thread: BotThread,
  message: IncomingMessage,
  opts: AssistantRunOptions = {},
): Promise<void> {
  const enriched = await ensureAttachments(thread, message);
  opts.logger?.logIncoming(enriched);
  const { content, warnings } = await buildPromptFromMessage(enriched);
  if (warnings.length > 0) {
    await thread.post({ markdown: warnings.map((w) => `> ${w}`).join("\n") });
  }
  const stream = await runAgent(content, opts);
  await deliverToChat(stream, thread);
  await opts.logger?.flush();
}

async function postInternalError(thread: BotThread): Promise<void> {
  try {
    await thread.post({
      markdown:
        "I hit an internal error while generating a reply. Please try again.",
    });
  } catch {
    // Ignore secondary failures
  }
}

async function runWithProcessingLifecycle(
  thread: BotThread,
  message: IncomingMessage,
  failureContext: string,
  run: () => Promise<void>,
): Promise<void> {
  await markProcessingStart(thread, message);

  let success = false;
  try {
    await run();
    success = true;
  } catch (error) {
    console.error(failureContext, error);
    await postInternalError(thread);
  } finally {
    if (success) {
      await markProcessingComplete(thread, message);
    } else {
      await clearProcessingIndicator(thread, message);
    }
  }
}

async function handleIncomingMessage(
  thread: BotThread,
  message: IncomingMessage,
  options: {
    failureContext: string;
    subscribe?: boolean;
    ignoreOwnMessages?: boolean;
    setup?: AssistantRunSetup;
  },
): Promise<void> {
  if (options.ignoreOwnMessages && message.author.isMe) return;
  if (!isAccessAllowed(thread, message)) return;

  const logger = new ThreadLogger(thread.adapter.name, thread.id);
  logger.logSeparator(message.id);

  if (options.subscribe) {
    await thread.subscribe();
  }

  await runWithProcessingLifecycle(
    thread,
    message,
    options.failureContext,
    async () => {
      const setupOptions = await options.setup?.(logger);
      await runAssistant(thread, message, { ...setupOptions, logger });
    },
  );
}

async function loadSubscribedRunOptions(
  bot: BotChat,
  thread: BotThread,
  message: IncomingMessage,
  logger: ThreadLogger,
): Promise<AssistantRunOptions> {
  // Fetch thread history and digest context in parallel.
  const [history, digestContext] = await Promise.all([
    convertThreadHistory(thread, message.id),
    getDigestThreadContext(bot.getState(), thread.id),
  ]);
  logger.logHistory(history);

  return {
    history,
    prelude: digestContext
      ? buildDigestContextPrelude(digestContext)
      : undefined,
  };
}

export function registerHandlers(bot: BotChat): void {
  bot.onNewMention(async (thread, message) => {
    await handleIncomingMessage(thread, message, {
      failureContext: `[rina] Failed to handle first message in ${thread.id}`,
      subscribe: true,
    });
  });

  bot.onSubscribedMessage(async (thread, message) => {
    await handleIncomingMessage(thread, message, {
      failureContext: `[rina] Failed to handle subscribed message in ${thread.id}`,
      ignoreOwnMessages: true,
      setup: (logger) => loadSubscribedRunOptions(bot, thread, message, logger),
    });
  });

  // Catch-all for Telegram DMs (they don't have @mentions)
  bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
    if (!isTelegramDirectMessage(thread)) return;
    await handleIncomingMessage(thread, message, {
      failureContext: `[rina] Failed to handle first message in ${thread.id}`,
      subscribe: true,
    });
  });
}
