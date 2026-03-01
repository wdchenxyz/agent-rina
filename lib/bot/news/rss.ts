export interface RSSItem {
  title: string;
  link: string;
  guid: string;
  commentsLink: string;
  pubDate: string;
}

const DEFAULT_FEED = "https://hnrss.org/newest?points=100";

function parseItems(xml: string): RSSItem[] {
  const items: RSSItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const tag = (name: string) =>
      block.match(new RegExp(`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>`))?.[1] ??
      block.match(new RegExp(`<${name}>(.*?)<\\/${name}>`))?.[1] ??
      "";

    const title = tag("title");
    const link = tag("link");
    const guid = tag("guid") || link;
    const commentsLink = tag("comments");
    const pubDate = tag("pubDate");

    if (title && link) {
      items.push({ title, link, guid, commentsLink, pubDate });
    }
  }

  return items;
}

export async function fetchRSSFeed(feedUrl: string): Promise<RSSItem[]> {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "agent-rina/1.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  return parseItems(xml);
}

export async function fetchAllFeeds(
  feeds?: string[],
): Promise<RSSItem[]> {
  const urls = feeds && feeds.length > 0 ? feeds : [DEFAULT_FEED];

  const results = await Promise.allSettled(
    urls.map((url) => fetchRSSFeed(url)),
  );

  const items: RSSItem[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[news] feed fetch failed:", result.reason);
      continue;
    }
    for (const item of result.value) {
      if (!seen.has(item.guid)) {
        seen.add(item.guid);
        items.push(item);
      }
    }
  }

  return items;
}
