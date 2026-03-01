import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Adapter } from "chat";
import { registerHandlers } from "../rina";
import { startNewsScheduler } from "./news/scheduler";
import type { BotThreadState } from "./types";

function buildAdapters(): Record<string, Adapter> {
  const adapters: Record<string, Adapter> = {};

  const hasSlackToken = Boolean(process.env.SLACK_BOT_TOKEN);
  const hasSlackSigningSecret = Boolean(process.env.SLACK_SIGNING_SECRET);

  if (hasSlackToken !== hasSlackSigningSecret) {
    throw new Error(
      "Slack adapter misconfigured: set both SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.",
    );
  }

  if (hasSlackToken && hasSlackSigningSecret) {
    adapters.slack = createSlackAdapter();
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    adapters.telegram = createTelegramAdapter({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
    });
  }

  if (Object.keys(adapters).length === 0) {
    throw new Error(
      "No adapters configured. Configure Slack and/or Telegram environment variables.",
    );
  }

  return adapters;
}

const adapters = buildAdapters();

export const bot = new Chat<Record<string, Adapter>, BotThreadState>({
  userName: process.env.BOT_USERNAME || "mybot",
  adapters,
  state: createRedisState(),
});

registerHandlers(bot);
// startNewsScheduler(bot);
