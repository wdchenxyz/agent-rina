import { after } from "next/server";
import { bot } from "@/lib/bot";

type Platform = keyof typeof bot.webhooks;

type ErrorWithCode = Error & {
  code?: string;
  cause?: { code?: string };
  originalError?: { code?: string; cause?: { code?: string } };
};

function isTransientNetworkAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const withCode = error as ErrorWithCode;
  const codes = new Set([
    withCode.code,
    withCode.cause?.code,
    withCode.originalError?.code,
    withCode.originalError?.cause?.code,
  ]);
  const message = error.message.toLowerCase();

  return (
    codes.has("ECONNRESET") ||
    codes.has("UND_ERR_CONNECT_TIMEOUT") ||
    message.includes("aborted") ||
    message.includes("connect timeout")
  );
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/webhooks/[platform]">
) {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }

  try {
    return await handler(request, {
      waitUntil: (task) =>
        after(async () => {
          try {
            await task;
          } catch (error) {
            if (!isTransientNetworkAbort(error)) {
              console.error(`[webhooks:${platform}] background task failed`, error);
            }
          }
        }),
    });
  } catch (error) {
    if (isTransientNetworkAbort(error)) {
      return new Response("OK", { status: 200 });
    }
    throw error;
  }
}
