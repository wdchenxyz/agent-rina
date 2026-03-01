export async function onRequestError() {
  // Required export — no-op
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Eagerly import the bot module so side effects run at startup.
    // This ensures node-cron schedulers (news digest) start immediately
    // rather than waiting for the first webhook request.
    await import("@/lib/bot");
  }
}
