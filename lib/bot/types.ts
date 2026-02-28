import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message, Thread } from "chat";

export interface BotThreadState {
  sdkSessionId?: string;
}

export type BotThread = Thread<BotThreadState>;
export type IncomingMessage = Message;
export type QueryPrompt = Parameters<typeof query>[0]["prompt"];
