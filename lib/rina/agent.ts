import {
  ToolLoopAgent,
  gateway,
  stepCountIs,
  type ModelMessage,
  type UserContent,
  type ToolSet,
} from "ai";
import { resolve } from "path";

import { SYSTEM_PROMPT, mentionInstructions } from "./constants";
import { imageDebug } from "./debug";
import type { ThreadLogger } from "./logger";
import { planRequest, type RequestPlan } from "./planner";
import {
  activeToolsForIntent,
  createCoreTools,
  type KnownToolName,
} from "./tools/registry";

const MAX_STEPS = 20;

// --- Stream part type (simplified from AI SDK's TextStreamPart) ---

export interface StreamPart {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
}

export interface AgentRunMetadata {
  plan: RequestPlan;
  activeTools: string[];
}

// --- Lazy bash/skill tool setup ---

let bashToolsPromise: Promise<Record<string, unknown>> | null = null;

async function loadBashAndSkillTools(): Promise<Record<string, unknown>> {
  // Dynamic import because bash-tool is ESM-only
  const { createBashTool, experimental_createSkillTool: createSkillTool } =
    await import("bash-tool");

  const skillsDir = resolve(process.cwd(), ".agents/skills");
  const {
    skill,
    files: skillFiles,
    instructions: skillInstructions,
  } = await createSkillTool({ skillsDirectory: skillsDir });

  const { tools: bashTools } = await createBashTool({
    uploadDirectory: {
      source: ".",
      include: "{app,lib,docs,.agents}/**/*.{ts,tsx,json,md,yaml,yml}",
    },
    files: skillFiles,
    extraInstructions: skillInstructions,
    onBeforeBashCall: ({ command }) => {
      console.log(`[rina] bash: ${command}`);
      return undefined;
    },
    onAfterBashCall: ({ command, result }) => {
      if (result.exitCode !== 0) {
        console.log(
          `[rina] bash exit ${result.exitCode}: ${command}\n  stderr: ${result.stderr.slice(0, 200)}`,
        );
      }
      return undefined;
    },
  });

  return { ...bashTools, skill };
}

function getBashAndSkillTools(): Promise<Record<string, unknown>> {
  if (!bashToolsPromise) {
    bashToolsPromise = loadBashAndSkillTools();
  }
  return bashToolsPromise;
}

// --- Stream logging wrapper ---
// Taps into the stream to log tool calls, results, and text blocks without
// altering what downstream consumers see.

export async function* withLogging(
  stream: AsyncIterable<StreamPart>,
  logger: ThreadLogger,
): AsyncGenerator<StreamPart> {
  const toolNamesByCall = new Map<string, string>();
  const toolInputChunksByCall = new Map<string, string[]>();
  let textChunks: string[] = [];

  for await (const part of stream) {
    const toolCallId = part.toolCallId ?? "current";

    // Tool input tracking
    if (part.type === "tool-input-start") {
      const toolName = part.toolName ?? "unknown";
      toolNamesByCall.set(toolCallId, toolName);
      toolInputChunksByCall.set(toolCallId, []);
    }
    if (part.type === "tool-input-delta") {
      const delta = (part as StreamPart & { inputTextDelta?: string }).inputTextDelta ?? part.text;
      if (delta) {
        const chunks = toolInputChunksByCall.get(toolCallId) ?? [];
        chunks.push(delta);
        toolInputChunksByCall.set(toolCallId, chunks);
      }
    }
    if (part.type === "tool-input-end") {
      const toolName = toolNamesByCall.get(toolCallId) ?? "unknown";
      logger.logToolCall(toolName, (toolInputChunksByCall.get(toolCallId) ?? []).join(""));
    }

    // Tool result — AI SDK uses `output` (not `result`) on tool-result parts
    if (part.type === "tool-result") {
      const toolName =
        part.toolName ?? toolNamesByCall.get(toolCallId) ?? "unknown";
      const raw = (part as StreamPart & { output?: unknown; result?: unknown }).output
        ?? (part as StreamPart & { result?: unknown }).result;
      const output =
        typeof raw === "string"
          ? raw
          : raw === undefined
            ? "(no output)"
            : JSON.stringify(raw, null, 2) ?? "(unserializable)";
      logger.logToolResult(toolName, output);
    }

    // Text block tracking
    if (part.type === "text-start") {
      textChunks = [];
    }
    if (part.type === "text-delta" && part.text) {
      textChunks.push(part.text);
    }
    if (part.type === "text-end") {
      const full = textChunks.join("");
      if (full.trim()) logger.logResponse(full);
    }

    yield part;
  }
}

// --- Main agent entry point (pure cognitive engine) ---

export async function runAgent(
  content: UserContent,
  opts: { prelude?: string; history?: ModelMessage[]; logger?: ThreadLogger; platform?: string } = {},
): Promise<AsyncIterable<StreamPart>> {
  const { logger } = opts;

  // Build tools — no thread dependency
  const coreTools = createCoreTools();
  const extraTools = await getBashAndSkillTools();
  const allTools = {
    ...coreTools,
    ...extraTools,
  } as ToolSet;
  const plan = planRequest(content);
  const initialActiveTools = activeToolsForIntent(plan.intent).filter(
    (toolName) => toolName in allTools,
  ) as KnownToolName[];

  const agent = new ToolLoopAgent({
    // model: gateway("anthropic/claude-sonnet-4-6"),
    model: gateway("openai/gpt-5.2"),
    instructions: SYSTEM_PROMPT + mentionInstructions(opts.platform ?? "slack"),
    tools: allTools,
    stopWhen: stepCountIs(MAX_STEPS),
    prepareStep: async ({ stepNumber }) => {
      if (stepNumber <= 2) {
        return { activeTools: initialActiveTools };
      }

      return {};
    },
  });

  // Build messages: history first, then prelude, then current user message
  const messages: ModelMessage[] = [...(opts.history ?? [])];
  if (opts.prelude) {
    messages.push({ role: "user", content: opts.prelude });
  }
  messages.push({ role: "user", content });

  // Debug: log message structure
  imageDebug(`[rina:image-debug] runAgent: ${messages.length} messages total`);
  for (const [i, msg] of messages.entries()) {
    if (typeof msg.content === "string") {
      imageDebug(`[rina:image-debug]   [${i}] role=${msg.role}, content="${msg.content.slice(0, 80)}"`);
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p: { type: string }) => p.type === "text").length;
      const imageParts = msg.content.filter((p: { type: string }) => p.type === "image").length;
      imageDebug(`[rina:image-debug]   [${i}] role=${msg.role}, parts: ${textParts} text + ${imageParts} image`);
    }
  }

  // Log the full prompt sent to the agent
  logger?.logPrompt(messages);
  logger?.logRunMetadata({
    plan,
    activeTools: initialActiveTools,
  });

  const result = await agent.stream({ messages });

  // Cast fullStream to simplified type to avoid deep generics issues
  const rawStream = result.fullStream as unknown as AsyncIterable<StreamPart>;
  return logger ? withLogging(rawStream, logger) : rawStream;
}
