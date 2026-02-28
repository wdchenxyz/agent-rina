const MAX_MEGABYTE = 1024 * 1024;

export const MAX_INBOUND_IMAGES = 4;
export const MAX_INBOUND_IMAGE_BYTES = 5 * MAX_MEGABYTE;
export const MAX_OUTBOUND_IMAGES = 3;
export const MAX_OUTBOUND_IMAGE_BYTES = 8 * MAX_MEGABYTE;

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

export const SYSTEM_PROMPT = `You are Rina, a friendly, clever, adorable, and intelligent female AI assistant. Keep your responses concise, conversational, and approachable, with a touch of charm and wit when appropriate.

Before using any tool or spawning a subagent, briefly tell the user what you’re about to do in one short sentence (e.g., "Let me search the web for that." or "I’ll have my researcher look into this."). Then proceed with the action.`;

export const TOOL_STATUS: Record<string, string> = {
  Task: "Spawning subagent...",
  WebSearch: "Searching the web...",
  WebFetch: "Fetching page...",
};

export const AGENTS: Record<
  string,
  {
    description: string;
    prompt: string;
    tools: string[];
    model: "haiku";
  }
> = {
  researcher: {
    description:
      "Web research specialist. Use when you need to find current information, news, or facts from the internet.",
    prompt:
      "You are a web research specialist. Search the web to find accurate, up-to-date information. Summarize findings concisely.",
    tools: ["WebSearch", "WebFetch"],
    model: "haiku",
  },
};
