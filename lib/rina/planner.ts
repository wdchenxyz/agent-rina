import type { UserContent } from "ai";
import type { ToolIntent } from "./tools/registry";

export interface RequestPlan {
  intent: ToolIntent;
  reason: string;
}

function contentText(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function hasMedia(content: UserContent): boolean {
  return Array.isArray(content)
    ? content.some((part) => part.type === "image" || part.type === "file")
    : false;
}

export function planRequest(content: UserContent): RequestPlan {
  const text = contentText(content).toLowerCase();

  if (/\barxiv\b|arxiv\.org|paper|latex|summari[sz]e.+(paper|pdf)|research paper/.test(text)) {
    return { intent: "paper", reason: "paper or arXiv workflow requested" };
  }

  if (/\b(news|latest|today|recent|current|search|look up|web|url|website|source|citation|cite)\b/.test(text)) {
    return { intent: "research", reason: "current or sourced information requested" };
  }

  if (/\b(plot|chart|csv|dataframe|pandas|numpy|python|analy[sz]e data|statistics|regression)\b/.test(text)) {
    return { intent: "data", reason: "data analysis or Python execution requested" };
  }

  if (/\b(repo|codebase|file|files|directory|implement|bug|debug|test|lint|branch|commit|diff)\b/.test(text)) {
    return { intent: "codebase", reason: "project or codebase task requested" };
  }

  if (/\b(artifact|upload|download|attach|attachment|image|pdf|csv|json)\b/.test(text)) {
    return { intent: "artifact", reason: "artifact or file operation requested" };
  }

  if (hasMedia(content)) {
    return { intent: "file", reason: "message contains supported media" };
  }

  return { intent: "chat", reason: "general conversational request" };
}
