# Agent Rina

Multi-platform AI bot powered by Chat SDK + AI SDK `ToolLoopAgent`, supporting:

- Slack
- Telegram

## Architecture

- Chat adapters: `lib/bot/index.ts`
- Shared Rina handlers: `lib/rina/handlers.ts`
- Agent runtime/tool harness: `lib/rina/agent.ts`
- Tool registry and routing: `lib/rina/tools/registry.ts`, `lib/rina/planner.ts`
- Delivery bridge: `lib/rina/delivery.ts`
- Webhook route: `app/api/webhooks/[platform]/route.ts`

## Environment Variables

Required for all modes:

- `AI_GATEWAY_API_KEY`
- `REDIS_URL`

Slack (optional, both required together):

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

Telegram (optional):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (recommended)

Optional:

- `BOT_USERNAME` (default: `mybot`)
- `BOT_ALLOWED_USER_IDS` (comma-separated user IDs)
- `BOT_ALLOWED_CHAT_IDS` (comma-separated chat/channel IDs)
- `BOT_ALLOWED_USER_IDS_SLACK` (comma-separated Slack user IDs)
- `BOT_ALLOWED_USER_IDS_TELEGRAM` (comma-separated Telegram user IDs)
- `BOT_ALLOWED_CHAT_IDS_SLACK` (comma-separated Slack channel IDs)
- `BOT_ALLOWED_CHAT_IDS_TELEGRAM` (comma-separated Telegram chat IDs)
- `RINA_MAX_HISTORY_MESSAGES` (default: `30`, caps thread messages sent to the model)
- `RINA_WEB_PROVIDER` (`parallel`, `gateway`, or `disabled`; see Web search below)
- `RINA_IMAGE_DEBUG=1` (optional, logs detailed attachment/model content shaping)
- `TELEGRAM_WEBHOOK_URL` (for webhook registration convenience)

Allowlist behavior:

- Per-platform vars take precedence when set (`*_SLACK`, `*_TELEGRAM`).
- Global vars are fallback when platform-specific vars are unset.
- User and chat checks are both applied: if both relevant lists are set, both must match.
- If all relevant lists are unset: allow all.

If neither Slack nor Telegram env vars are configured, startup fails with a clear error.

## Local Development

```bash
pnpm install
pnpm dev
```

Server runs on `http://localhost:3000`.

Webhook endpoints:

- Slack: `POST /api/webhooks/slack`
- Telegram: `POST /api/webhooks/telegram`

CLI playground:

```bash
pnpm pg "summarize this link and include useful images: <public-article-url>"
```

Replace `<public-article-url>` with a real public article URL. This bypasses Slack/Telegram and exercises the same Rina agent, tool registry, and delivery bridge with a mock chat thread.

## Tool Harness

- `researchWeb`: current sourced research through the configured web provider.
- `fetchWebpage`: text excerpts or a grounded summary of a specific public URL through the configured web provider.
- `extractWebpageAssets`: safe-fetches a specific webpage, extracts readable content with Defuddle, ranks useful article images, and posts selected images through the existing file delivery layer.
- `runPythonCode`: runs Python in a Vercel Sandbox and auto-posts requested output files.

## Web search

Rina supports [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
for free web search and page excerpts, with no Parallel account or API key. Search
uses Fast mode. Set `RINA_WEB_PROVIDER=parallel` to use it for `researchWeb`,
`webSearch`, and `fetchWebpage`. The outer Rina model synthesizes answers from
returned excerpts and source URLs; search does not make an additional model call.
The main agent still needs its AI Gateway credentials.

When `RINA_WEB_PROVIDER` is unset, an existing `AI_GATEWAY_API_KEY` or
`VERCEL_OIDC_TOKEN` keeps the Gateway-backed tools. Without either credential,
web search defaults to anonymous Parallel MCP. Set `RINA_WEB_PROVIDER=gateway`
explicitly for the existing Google/Perplexity cross-checking and Gemini URL
context, or `RINA_WEB_PROVIDER=disabled` to remove the web search and page tools
from the agent. This setting does not disable network access in other tools.
Invalid provider values fail configuration instead of silently choosing a provider.

Parallel uses the Streamable HTTP endpoint `https://search.parallel.ai/mcp`.
Calls have a 45-second deadline, respect agent cancellation, and return service
errors without falling back to another provider. Anonymous use has service rate
limits. Specific page reads reject local/private URLs before contacting MCP.
Parallel returns source excerpts, rather than the Gateway's two-provider
cross-checking or Gemini summaries. For Perplexity's strict `recency` and
`maxResults` controls, use `perplexitySearch`, which remains explicitly available
when web tools are enabled. `extractWebpageAssets` continues to handle images.

Try it with the same agent and delivery bridge used by Slack and Telegram:

```bash
RINA_WEB_PROVIDER=parallel pnpm pg "search for the latest NASA Artemis mission news and cite sources"
RINA_WEB_PROVIDER=parallel pnpm pg "summarize https://www.nasa.gov/ without images"
```

## Telegram Setup

Telegram requires a public HTTPS webhook URL. For local development, expose your local server with a tunnel (for example ngrok or cloudflared) and set:

- `TELEGRAM_WEBHOOK_URL=https://<public-url>/api/webhooks/telegram`

Then register webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$TELEGRAM_WEBHOOK_URL" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Platform Behavior

Slack:

- Responds to mentions in new threads
- Subscribes thread and handles follow-up messages
- Uses reaction indicators (`eyes`, `check`)

Telegram:

- Responds to mentions in groups/supergroups
- Responds to direct messages via `onNewMessage` fallback handler
- Uses the same per-thread Rina history and digest context

## Verification

```bash
pnpm exec next typegen
pnpm exec tsc --noEmit
pnpm test:web
pnpm lint
pnpm build
```

Suggested local smoke prompts:

```bash
pnpm pg "summarize this link and include useful images: <public-article-url>"
pnpm pg "summarize this link without images: <public-article-url>"
pnpm pg "try to summarize http://localhost:3000 and explain the result briefly"
```
