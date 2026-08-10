# Steam Free Games Bot

This Telegram bot checks a [permanent Steam search](https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1) once an hour and notifies friends about paid games that are temporarily discounted by 100%.

- `/start` subscribes the user and immediately shows current giveaways if the cache has already been populated.
- `/stop` unsubscribes the user.
- Ended giveaways do not produce notifications.
- If the same game becomes free again later, the bot sends it again.

The bot runs on the free Cloudflare Workers and D1 tiers. It does not require a server. This implementation is intended for a small group of roughly 30–40 friends.

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js 22 or newer and npm.
- A Telegram bot created through [@BotFather](https://t.me/BotFather).

Run `/newbot` in BotFather, choose a display name and username, and save the token it returns. Never add this token to project files or Git.

## 1. Install and verify

```bash
npm install
npm test
npm run check
```

`npm run check` runs the tests again and bundles the Worker with `wrangler deploy --dry-run`. It does not contact the real Steam or Telegram services.

Log in to Cloudflare:

```bash
npx wrangler login
```

## 2. Create the D1 database

Create the remote database:

```bash
npx wrangler d1 create steam-free-games-bot
```

Wrangler prints a `database_id` UUID. In [wrangler.jsonc](./wrangler.jsonc), replace `"local"` with that UUID. Do not change `binding` or `database_name`.

Apply the migration:

```bash
npx wrangler d1 migrations apply steam-free-games-bot --remote
```

Wrangler should list `0001_initial.sql` and ask you to confirm the remote database write.

## 3. Configure secrets

The following commands read the Telegram token without echoing it and pass it to Wrangler through stdin, so the value is not saved in shell history. The commands work in both Bash and zsh.

```bash
printf "Telegram bot token: "
stty -echo
IFS= read -r TELEGRAM_BOT_TOKEN
stty echo
printf "\n"
printf %s "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Generate a random webhook secret. Keep the variable in the current terminal because it is also needed after deployment.

```bash
TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)"
printf %s "$TELEGRAM_WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Do not close this terminal until the webhook is registered. If the variable is lost, generate another value and run `wrangler secret put` again.

## 4. Deploy

```bash
npx wrangler deploy
```

Wrangler prints an address similar to:

```text
https://steam-free-games-bot.<your-subdomain>.workers.dev
```

Enter the address without a trailing slash:

```bash
printf "Worker URL: "
IFS= read -r WORKER_URL
```

The `0 * * * *` cron trigger runs at the beginning of every UTC hour. The first successful run stores the active giveaways in D1.

## 5. Register the Telegram webhook

Run this in the same terminal:

```bash
curl -sS --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

The response should contain `"ok":true`. Verify the registration:

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

The `url` field should contain `${WORKER_URL}/webhook`, and `last_error_message` should be absent or empty.

Remove the secrets from the current shell environment:

```bash
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET WORKER_URL
```

## 6. Verify the bot in Telegram

1. Open `https://t.me/<your-bot-username>`.
2. Press Start or send `/start`.
3. The bot should immediately confirm the subscription.
4. If the first hourly Steam check has already completed and giveaways exist, the bot immediately shows them. Otherwise, it sends them after the next successful cron run.
5. Send `/stop` and confirm that the bot reports that notifications are disabled.

Each friend subscribes independently with `/start`. No administrator approval or manual chat ID configuration is required.

## Test the cron handler locally

This uses a separate local D1 database and does not modify production:

```bash
npx wrangler d1 migrations apply steam-free-games-bot --local
npx wrangler dev --test-scheduled
```

In another terminal:

```bash
curl -sS "http://localhost:8787/cdn-cgi/handler/scheduled"
```

For a complete local delivery test, create an ignored `.dev.vars` file with credentials for a separate test bot. Do not copy production credentials into the repository.

## Troubleshooting

Stream runtime errors without storing complete Telegram updates or chat IDs:

```bash
npx wrangler tail
```

If `/start` does not respond:

- Check `getWebhookInfo` and Telegram's latest webhook error.
- Verify that the URL ends with `/webhook`.
- Set the same `TELEGRAM_WEBHOOK_SECRET` in Cloudflare and `setWebhook` again.
- Verify that the remote D1 migration was applied.

If subscriptions work but no games appear:

- Wait until the beginning of the next UTC hour.
- Open the original Steam search and verify that a game is currently discounted by exactly 100%.
- Inspect cron exceptions in Cloudflare Workers Logs or with `wrangler tail`.

When a user blocks the bot, Telegram returns `403`, and the subscription is removed automatically. Temporary Telegram failures remain undelivered and are retried at the next hourly run only for the affected user.

If deployment reports an invalid D1 ID, replace the `"local"` value in `wrangler.jsonc` with the UUID returned by `wrangler d1 create`.

## Update and rollback

Before deploying an update:

```bash
npm ci
npm run check
npx wrangler deploy
```

To roll back, deploy a previously verified Git commit:

```bash
git switch --detach <commit>
npm ci
npx wrangler deploy
git switch -
```

This version's migration only creates tables. Rolling back the Worker does not require deleting D1 or reversing the schema.
