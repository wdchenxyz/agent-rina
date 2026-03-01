import type { BotThread, IncomingMessage } from "./types";

function parseAllowlist(envKey: string): Set<string> {
  const raw = process.env[envKey]?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function isIdAllowed(id: string | undefined, ...lists: Set<string>[]): boolean {
  if (!id) return false;
  // If all lists are empty (not configured), allow by default
  if (lists.every((list) => list.size === 0)) return true;
  return lists.some((list) => list.has(id));
}

export function isAccessAllowed(
  thread: BotThread,
  message: IncomingMessage,
): boolean {
  const platform = thread.adapter.name;

  const globalUsers = parseAllowlist("BOT_ALLOWED_USER_IDS");
  const globalChats = parseAllowlist("BOT_ALLOWED_CHAT_IDS");
  const platformUsers = parseAllowlist(
    `BOT_ALLOWED_USER_IDS_${platform.toUpperCase()}`,
  );
  const platformChats = parseAllowlist(
    `BOT_ALLOWED_CHAT_IDS_${platform.toUpperCase()}`,
  );

  const isUserAllowed = isIdAllowed(
    message.author.userId,
    platformUsers.size > 0 ? platformUsers : globalUsers,
  );
  const isChatAllowed = isIdAllowed(
    thread.id,
    platformChats.size > 0 ? platformChats : globalChats,
  );

  return isUserAllowed && isChatAllowed;
}
