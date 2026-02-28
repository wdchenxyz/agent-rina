import type { BotThread, IncomingMessage } from "./types";

function parseAllowlist(rawValue: string | undefined): Set<string> {
  if (!rawValue) return new Set();

  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set(values);
}

const allowedUserIds = parseAllowlist(process.env.BOT_ALLOWED_USER_IDS);
const allowedChatIds = parseAllowlist(process.env.BOT_ALLOWED_CHAT_IDS);
const allowedUserIdsSlack = parseAllowlist(process.env.BOT_ALLOWED_USER_IDS_SLACK);
const allowedUserIdsTelegram = parseAllowlist(
  process.env.BOT_ALLOWED_USER_IDS_TELEGRAM,
);
const allowedChatIdsSlack = parseAllowlist(process.env.BOT_ALLOWED_CHAT_IDS_SLACK);
const allowedChatIdsTelegram = parseAllowlist(
  process.env.BOT_ALLOWED_CHAT_IDS_TELEGRAM,
);

function selectUserAllowlist(adapterName: string): Set<string> {
  if (adapterName === "slack" && allowedUserIdsSlack.size > 0) {
    return allowedUserIdsSlack;
  }
  if (adapterName === "telegram" && allowedUserIdsTelegram.size > 0) {
    return allowedUserIdsTelegram;
  }
  return allowedUserIds;
}

function selectChatAllowlist(adapterName: string): Set<string> {
  if (adapterName === "slack" && allowedChatIdsSlack.size > 0) {
    return allowedChatIdsSlack;
  }
  if (adapterName === "telegram" && allowedChatIdsTelegram.size > 0) {
    return allowedChatIdsTelegram;
  }
  return allowedChatIds;
}

function isUserAllowed(thread: BotThread, message: IncomingMessage): boolean {
  const allowlist = selectUserAllowlist(thread.adapter.name);
  if (allowlist.size === 0) {
    return true;
  }
  return allowlist.has(message.author.userId);
}

function isChatAllowed(thread: BotThread): boolean {
  const allowlist = selectChatAllowlist(thread.adapter.name);
  if (allowlist.size === 0) {
    return true;
  }
  return allowlist.has(thread.channelId);
}

export function isAccessAllowed(
  thread: BotThread,
  message: IncomingMessage,
): boolean {
  return isUserAllowed(thread, message) && isChatAllowed(thread);
}
