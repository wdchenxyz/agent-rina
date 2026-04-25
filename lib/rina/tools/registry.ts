import { createArtifactTools } from "./artifacts";
import { createArxivTools } from "./arxiv";
import { createSandboxTools } from "./sandbox";
import { webTools } from "./web";

export type ToolCategory =
  | "artifact"
  | "bash"
  | "codebase"
  | "paper"
  | "python"
  | "skill"
  | "web";

export interface ToolMetadata {
  category: ToolCategory;
  status: string;
  sideEffect?: "none" | "network" | "filesystem" | "upload" | "execution";
  latency?: "low" | "medium" | "high";
  description: string;
}

export type ToolIntent =
  | "artifact"
  | "chat"
  | "codebase"
  | "data"
  | "file"
  | "paper"
  | "research";

export const TOOL_REGISTRY = {
  bash: {
    category: "bash",
    status: "Running command...",
    sideEffect: "execution",
    latency: "medium",
    description: "Explore project files and run shell commands in the bash-tool sandbox.",
  },
  skill: {
    category: "skill",
    status: "Loading skill guidance...",
    sideEffect: "none",
    latency: "low",
    description: "Select and read repo-local agent skills.",
  },
  webSearch: {
    category: "web",
    status: "Searching the web...",
    sideEffect: "network",
    latency: "medium",
    description: "Ground a general web answer with Google search via Gemini.",
  },
  researchWeb: {
    category: "web",
    status: "Researching across web sources...",
    sideEffect: "network",
    latency: "high",
    description: "Cross-check Google-grounded and Perplexity results for sourced answers.",
  },
  perplexitySearch: {
    category: "web",
    status: "Searching with Perplexity...",
    sideEffect: "network",
    latency: "medium",
    description: "Find recent news and current-event sources.",
  },
  fetchWebpage: {
    category: "web",
    status: "Fetching page...",
    sideEffect: "network",
    latency: "medium",
    description: "Read and summarize a specific URL.",
  },
  downloadFile: {
    category: "artifact",
    status: "Downloading file...",
    sideEffect: "filesystem",
    latency: "medium",
    description: "Download a URL into artifacts/ for later upload.",
  },
  listArtifacts: {
    category: "artifact",
    status: "Listing artifacts...",
    sideEffect: "none",
    latency: "low",
    description: "List files available in artifacts/.",
  },
  uploadArtifact: {
    category: "artifact",
    status: "Uploading artifact...",
    sideEffect: "upload",
    latency: "low",
    description: "Upload a file from artifacts/ to the active chat.",
  },
  downloadArxivSource: {
    category: "paper",
    status: "Downloading paper source...",
    sideEffect: "network",
    latency: "medium",
    description: "Download and extract arXiv LaTeX source.",
  },
  listPaperFiles: {
    category: "paper",
    status: "Listing paper files...",
    sideEffect: "none",
    latency: "low",
    description: "List files in an extracted arXiv source tree.",
  },
  readPaperFile: {
    category: "paper",
    status: "Reading paper...",
    sideEffect: "none",
    latency: "low",
    description: "Read a text file from extracted arXiv source.",
  },
  uploadPaperFigure: {
    category: "paper",
    status: "Uploading paper figure...",
    sideEffect: "upload",
    latency: "low",
    description: "Upload an extracted arXiv figure to chat.",
  },
  runPythonCode: {
    category: "python",
    status: "Running Python in sandbox...",
    sideEffect: "execution",
    latency: "high",
    description: "Run Python in a Vercel Sandbox and retrieve output files.",
  },
} satisfies Record<string, ToolMetadata>;

export type KnownToolName = keyof typeof TOOL_REGISTRY;

export function getToolStatus(toolName: string): string | undefined {
  return TOOL_REGISTRY[toolName as KnownToolName]?.status;
}

export function createCoreTools() {
  return {
    ...createArxivTools(),
    ...createArtifactTools(),
    ...createSandboxTools(),
    ...webTools,
  };
}

const TOOL_NAMES_BY_INTENT: Record<ToolIntent, KnownToolName[]> = {
  chat: ["listArtifacts"],
  artifact: ["downloadFile", "listArtifacts", "uploadArtifact", "bash"],
  codebase: ["bash", "skill", "listArtifacts", "uploadArtifact"],
  data: ["runPythonCode", "downloadFile", "listArtifacts", "uploadArtifact", "bash"],
  file: ["runPythonCode", "listArtifacts", "uploadArtifact", "bash"],
  paper: [
    "researchWeb",
    "webSearch",
    "fetchWebpage",
    "downloadArxivSource",
    "listPaperFiles",
    "readPaperFile",
    "uploadPaperFigure",
    "downloadFile",
    "uploadArtifact",
  ],
  research: [
    "researchWeb",
    "webSearch",
    "perplexitySearch",
    "fetchWebpage",
    "downloadFile",
    "listArtifacts",
    "uploadArtifact",
  ],
};

export function activeToolsForIntent(intent: ToolIntent): KnownToolName[] {
  return TOOL_NAMES_BY_INTENT[intent];
}
