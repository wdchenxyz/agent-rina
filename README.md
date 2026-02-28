# Agent Rina

Multi-platform AI bot powered by Chat SDK + Claude Agent SDK, supporting:

- Slack
- Telegram

## Architecture

- Chat adapters: `lib/bot/index.ts`
- Shared handlers: `lib/bot/handlers.ts`
- Claude runtime/streaming: `lib/bot/agent-runtime.ts`
- Webhook route: `app/api/webhooks/[platform]/route.ts`

## Environment Variables

Required for all modes:

- `ANTHROPIC_API_KEY`
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
- `CLAUDE_SDK_LOG_STDERR=1` (optional, logs Claude subprocess stderr for debugging)
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

## Telegram Setup

Telegram requires a public HTTPS webhook URL. For local development, expose your local server with a tunnel (for example ngrok or cloudflared) and set:

- `TELEGRAM_WEBHOOK_URL=https://<public-url>/api/webhooks/telegram`

Then register webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$TELEGRAM_WEBHOOK_URL" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Detailed guide: `docs/telegram-setup.md`

## Platform Behavior

Slack:

- Responds to mentions in new threads
- Subscribes thread and handles follow-up messages
- Uses reaction indicators (`eyes`, `check`)

Telegram:

- Responds to mentions in groups/supergroups
- Responds to direct messages via `onNewMessage` fallback handler
- Uses same per-thread Claude session resume logic

## Verification

```bash
pnpm lint
pnpm build
```
