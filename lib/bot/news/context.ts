import type { StateAdapter } from "chat";
import type { CuratedStory } from "./curate";

const DIGEST_CONTEXT_KEY_PREFIX = "news:digest-thread:";
const DIGEST_CONTEXT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface NewsDigestThreadContext {
  digestMessage: string;
  stories: CuratedStory[];
  postedAt: string;
}

function digestContextKey(threadId: string): string {
  return `${DIGEST_CONTEXT_KEY_PREFIX}${threadId}`;
}

export async function saveDigestThreadContext(
  stateAdapter: StateAdapter,
  threadId: string,
  digestMessage: string,
  stories: CuratedStory[],
): Promise<void> {
  await stateAdapter.set<NewsDigestThreadContext>(
    digestContextKey(threadId),
    {
      digestMessage,
      stories,
      postedAt: new Date().toISOString(),
    },
    DIGEST_CONTEXT_TTL_MS,
  );
}

export async function getDigestThreadContext(
  stateAdapter: StateAdapter,
  threadId: string,
): Promise<NewsDigestThreadContext | null> {
  return stateAdapter.get<NewsDigestThreadContext>(digestContextKey(threadId));
}

export function buildDigestContextPrelude(context: NewsDigestThreadContext): string {
  return [
    "The following Hacker News digest was posted earlier in this thread.",
    "Use it as context when answering the next user message.",
    "",
    context.digestMessage,
    "",
    `Digest posted at: ${context.postedAt}`,
  ].join("\n");
}
