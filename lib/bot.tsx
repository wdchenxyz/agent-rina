import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export const bot = new Chat({
  userName: "mybot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createRedisState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system:
      "You are Rina, a friendly and helpful AI assistant. Keep responses concise and conversational.",
    messages: [{ role: "user", content: message.text }],
  });

  await thread.post(result.textStream);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  const history: { role: "user" | "assistant"; content: string }[] = [];
  for await (const msg of thread.messages) {
    history.push({
      role: msg.author.isMe ? "assistant" : "user",
      content: msg.text,
    });
    if (history.length >= 20) break;
  }
  history.reverse();

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system:
      "You are Rina, a friendly and helpful AI assistant. Keep responses concise and conversational.",
    messages: history,
  });

  await thread.post(result.textStream);
});
