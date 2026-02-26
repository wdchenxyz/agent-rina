import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { query } from "@anthropic-ai/claude-agent-sdk";

const SYSTEM_PROMPT = `You are Rina, a friendly, clever, adorable, and intelligent female AI assistant. Keep your responses concise, conversational, and approachable, with a touch of charm and wit when appropriate.

Before using any tool or spawning a subagent, briefly tell the user what you’re about to do in one short sentence (e.g., "Let me search the web for that." or "I’ll have my researcher look into this."). Then proceed with the action.`;

const TOOL_STATUS: Record<string, string> = {
  Task: "Spawning subagent...",
  WebSearch: "Searching the web...",
  WebFetch: "Fetching page...",
};

const AGENTS = {
  researcher: {
    description:
      "Web research specialist. Use when you need to find current information, news, or facts from the internet.",
    prompt:
      "You are a web research specialist. Search the web to find accurate, up-to-date information. Summarize findings concisely.",
    tools: ["WebSearch", "WebFetch"],
    model: "haiku" as const,
  },
};

export const bot = new Chat({
  userName: "mybot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createRedisState(),
});

type Thread = Parameters<Parameters<typeof bot.onNewMention>[0]>[0];

async function handleQuery(
  thread: Thread,
  prompt: string,
  opts: { resume?: string } = {},
): Promise<string | undefined> {
  let sessionId: string | undefined;

  const q = query({
    prompt,
    options: {
      model: "sonnet",
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      allowedTools: ["WebSearch", "WebFetch", "Task"],
      agents: AGENTS,
      maxTurns: 20,
      includePartialMessages: true,
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  });

  // State for streaming text to thread.post() concurrently
  let chunks: string[] = [];
  let chunkResolve: (() => void) | null = null;
  let streamDone = false;
  let currentPost: Promise<unknown> | null = null;

  async function* textStream(): AsyncGenerator<string> {
    while (true) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (streamDone) return;
      await new Promise<void>((r) => (chunkResolve = r));
    }
  }

  function startTextStream() {
    chunks = [];
    streamDone = false;
    chunkResolve = null;
    // Start posting — don't await, let it consume concurrently
    currentPost = thread.post(textStream());
  }

  function pushChunk(text: string) {
    chunks.push(text);
    chunkResolve?.();
  }

  async function endTextStream() {
    streamDone = true;
    chunkResolve?.();
    await currentPost;
    currentPost = null;
  }

  let inTextBlock = false;

  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type !== "stream_event" || message.parent_tool_use_id) {
      continue;
    }

    const event = message.event;

    // New text content block → start streaming a new message
    if (
      event.type === "content_block_start" &&
      event.content_block.type === "text"
    ) {
      startTextStream();
      inTextBlock = true;
    }

    // Text delta → push to the active stream
    if (
      inTextBlock &&
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      pushChunk(event.delta.text);
    }

    // Content block ended → finalize the message
    if (event.type === "content_block_stop" && inTextBlock) {
      await endTextStream();
      inTextBlock = false;
    }

    // Tool use → post status as a separate message
    if (
      event.type === "content_block_start" &&
      event.content_block.type === "tool_use"
    ) {
      const status = TOOL_STATUS[event.content_block.name];
      if (status) await thread.post(`> ${status}`);
    }
  }

  // Close any dangling stream
  if (inTextBlock) await endTextStream();

  return sessionId;
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();

  const sessionId = await handleQuery(thread, message.text);
  if (sessionId) await thread.setState({ sdkSessionId: sessionId });
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  const state = await thread.state;
  const sessionId = await handleQuery(thread, message.text, {
    resume: state?.sdkSessionId as string | undefined,
  });
  if (sessionId) await thread.setState({ sdkSessionId: sessionId });
});
