import { generateObject } from "ai";
import { z } from "zod";
import type { RSSItem } from "./rss";

export interface CuratedStory {
  title: string;
  link: string;
  commentsLink: string;
  summary: string;
}

export interface CuratedDigest {
  stories: CuratedStory[];
}

const digestSchema = z.object({
  stories: z.array(
    z.object({
      index: z.number(),
      summary: z.string(),
    }),
  ),
});

export async function curateNews(
  items: RSSItem[],
  maxStories: number,
): Promise<CuratedDigest | null> {
  if (items.length === 0) return null;

  const numbered = items
    .map((item, i) => `[${i}] ${item.title} — ${item.link}`)
    .join("\n");

  const { object } = await generateObject({
    model: "anthropic/claude-haiku-4-5-20251001",
    schema: digestSchema,
    prompt: [
      `You are a tech news curator. Pick the ${maxStories} most interesting and diverse stories from the list below.`,
      `For each, write a single-sentence summary (max 120 chars) highlighting why it matters.`,
      `Return the story indices and summaries. Prefer a mix of topics (AI, systems, security, open-source, startups).`,
      "",
      numbered,
    ].join("\n"),
  });

  const stories: CuratedStory[] = [];
  for (const pick of object.stories) {
    const item = items[pick.index];
    if (!item) continue;
    stories.push({
      title: item.title,
      link: item.link,
      commentsLink: item.commentsLink,
      summary: pick.summary,
    });
  }

  return stories.length > 0 ? { stories } : null;
}
