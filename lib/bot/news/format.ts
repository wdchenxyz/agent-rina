import type { CuratedDigest } from "./curate";

export function formatDigest(digest: CuratedDigest): string {
  const lines: string[] = [];

  lines.push("*Hacker News Digest*\n");

  digest.stories.forEach((story, i) => {
    const num = i + 1;
    const discussion = story.commentsLink
      ? ` (<${story.commentsLink}|discussion>)`
      : "";
    lines.push(
      `${num}. *${story.title}* — <${story.link}|link>${discussion}`,
    );
    lines.push(`    ${story.summary}\n`);
  });

  return lines.join("\n");
}
