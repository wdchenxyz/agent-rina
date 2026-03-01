import cron from "node-cron";
import type { Adapter, Chat } from "chat";
import type { BotThreadState } from "../types";
import { fetchAllFeeds } from "./rss";
import { curateNews } from "./curate";
import { formatDigest } from "./format";
import { saveDigestThreadContext } from "./context";

type BotChat = Chat<Record<string, Adapter>, BotThreadState>;

const DEDUP_CAP = 500;
const seenGuids = new Set<string>();

function getConfig() {
  const enabled = process.env.NEWS_ENABLED === "1";
  const channelId = process.env.NEWS_SLACK_CHANNEL_ID ?? "";
  const schedule = process.env.NEWS_CRON_SCHEDULE ?? "0 9 * * 1-5";
  const feeds = process.env.NEWS_RSS_FEEDS
    ? process.env.NEWS_RSS_FEEDS.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const maxItems = parseInt(process.env.NEWS_MAX_ITEMS ?? "10", 10);
  const digestSize = parseInt(process.env.NEWS_DIGEST_SIZE ?? "5", 10);
  return { enabled, channelId, schedule, feeds, maxItems, digestSize };
}

export async function runDigestCycle(bot: BotChat): Promise<void> {
  const { channelId, feeds, maxItems, digestSize } = getConfig();

  // Ensure Chat SDK is fully initialized (state + adapters) before using it.
  // handleWebhook() calls this lazily, but the scheduler runs outside that flow.
  await bot.initialize();

  console.log("[news] starting digest cycle");

  const allItems = await fetchAllFeeds(feeds);
  console.log(`[news] fetched ${allItems.length} items`);

  // Filter out previously seen items
  const fresh = allItems.filter((item) => !seenGuids.has(item.guid));
  console.log(`[news] ${fresh.length} fresh items after dedup`);

  if (fresh.length === 0) {
    console.log("[news] no fresh items, skipping cycle");
    return;
  }

  // Mark as seen (cap the set to prevent unbounded growth)
  for (const item of fresh) {
    seenGuids.add(item.guid);
  }
  if (seenGuids.size > DEDUP_CAP) {
    const toRemove = seenGuids.size - DEDUP_CAP;
    const iter = seenGuids.values();
    for (let i = 0; i < toRemove; i++) {
      seenGuids.delete(iter.next().value!);
    }
  }

  // Trim to maxItems for curation
  const candidates = fresh.slice(0, maxItems);

  const digest = await curateNews(candidates, digestSize);
  if (!digest) {
    console.log("[news] curation returned no stories, skipping");
    return;
  }

  const message = formatDigest(digest);
  console.log(`[news] posting digest (${digest.stories.length} stories) to ${channelId}`);

  const stateAdapter = bot.getState();
  const sent = await bot.channel(channelId).post(message);

  // Subscribe so the bot responds to replies on the digest thread.
  // channel.post() returns threadId with empty thread_ts (e.g. "slack:C123:")
  // but replies arrive with the message ts as thread_ts (e.g. "slack:C123:1234.5678").
  // Construct the correct reply threadId from channelId + message id.
  const replyThreadId = `${channelId}:${sent.id}`;
  await stateAdapter.subscribe(replyThreadId);
  await saveDigestThreadContext(stateAdapter, replyThreadId, message, digest.stories);

  console.log(`[news] digest posted, subscribed, and context saved for ${replyThreadId}`);
}

export function startNewsScheduler(bot: BotChat): void {
  const { enabled, channelId, schedule } = getConfig();

  if (!enabled) {
    console.log("[news] scheduler disabled (NEWS_ENABLED != 1)");
    return;
  }

  if (!channelId) {
    console.error("[news] NEWS_SLACK_CHANNEL_ID is required when NEWS_ENABLED=1");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[news] invalid cron schedule: ${schedule}`);
    return;
  }

  console.log(`[news] scheduler started — schedule: "${schedule}", channel: ${channelId}`);

  cron.schedule(schedule, async () => {
    try {
      await runDigestCycle(bot);
    } catch (err) {
      console.error("[news] digest cycle failed:", err);
    }
  });
}
