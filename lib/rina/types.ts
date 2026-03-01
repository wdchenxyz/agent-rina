import type { Message, Thread } from "chat";

export type BotThreadState = Record<string, unknown>;

export type BotThread = Thread<BotThreadState>;

export type IncomingMessage = Message;
