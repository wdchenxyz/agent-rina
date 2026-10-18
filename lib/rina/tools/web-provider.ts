export type WebProvider = "parallel" | "gateway" | "disabled";

/** Resolve once per agent run, preserving existing Gateway installations. */
export function resolveWebProvider(
  env: Record<string, string | undefined> = process.env,
): WebProvider {
  const selected = env.RINA_WEB_PROVIDER?.trim();
  if (selected) {
    if (selected === "parallel" || selected === "gateway" || selected === "disabled") {
      return selected;
    }
    throw new Error("RINA_WEB_PROVIDER must be parallel, gateway, or disabled.");
  }

  return env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim()
    ? "gateway"
    : "parallel";
}
