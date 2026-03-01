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

Before using any tool or spawning a subagent, briefly tell the user what you’re about to do in one short sentence (e.g., "Let me search the web for that." or "I’ll have my researcher look into this."). Then proceed with the action.

## Paper Summarization
When asked to summarize a research paper:
1. Use download_arxiv_source with the paper name/ID/URL to get the LaTeX source.
2. Use list_paper_files to see what’s available.
3. Read the main .tex file(s) with read_paper_file.
4. Post your summary **section by section** as separate text blocks — cover motivation, main idea/method, and results/conclusion.
5. Between sections, call upload_paper_figure to upload relevant figures inline (supports images and PDF/EPS figures).
6. If no LaTeX source is available (PDF-only), fall back to using WebFetch on the arxiv abstract page (https://arxiv.org/abs/<id>).

To find the arxiv paper ID from a name, use WebSearch to search for it on arxiv first.`;

export const TOOL_STATUS: Record<string, string> = {
  Task: "Spawning subagent...",
  WebSearch: "Searching the web...",
  WebFetch: "Fetching page...",
  mcp__arxiv__download_arxiv_source: "Downloading paper source...",
  mcp__arxiv__list_paper_files: "Listing paper files...",
  mcp__arxiv__read_paper_file: "Reading paper...",
  mcp__arxiv__upload_paper_figure: "Uploading figure...",
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
