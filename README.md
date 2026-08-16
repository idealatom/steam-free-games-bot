# Steam Free Games Announcements

A serverless Cloudflare Worker that checks Steam every hour and posts newly free paid games to a Telegram channel.

## How it works

1. A Cron Trigger runs the Worker once per hour.
2. The Worker fetches Steam's current `-100%` search results.
3. It compares them with the previous result stored in Cloudflare D1.
4. If games were added, it publishes all of them in one Telegram channel post.
5. It saves the new Steam state only after Telegram accepts the post.

That last step favors an occasional duplicate over a missed announcement. Removals and unchanged results do not produce posts. On the first non-empty run, every current result is announced.

## Free-tier usage

The normal hourly run makes one Worker invocation, one Steam request, a few D1 queries, and either zero or one Telegram API request. The number of channel subscribers does not affect Cloudflare or Telegram API usage.

## Requirements

- Node.js 22 or newer
- A Cloudflare account
- A Telegram bot token from BotFather
- A public Telegram channel where the bot is an administrator with permission to post messages

## Setup

Install dependencies:

```bash
npm install
```

Create a D1 database:

```bash
npx wrangler d1 create steam-free-games-bot
```

Copy the returned database ID into `wrangler.jsonc`, then set `TELEGRAM_CHANNEL_ID` to the channel username, including `@`.

Apply the migrations:

```bash
npx wrangler d1 migrations apply steam-free-games-bot --remote
```

Store the bot token as a Cloudflare secret:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

If this Worker previously used private bot subscriptions, remove the old webhook and discard pending private updates before deploying the channel-only version:

```bash
printf "Telegram bot token: "
stty -echo
IFS= read -r TELEGRAM_BOT_TOKEN
stty echo
printf "\n"
curl -sS --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" \
  --data-urlencode "drop_pending_updates=true"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
unset TELEGRAM_BOT_TOKEN
```

The first response must contain `"ok":true`, and the second response must show an empty `url`.

Deploy:

```bash
npx wrangler deploy
```

No Telegram webhook is required.

## Verification

Run the automated tests and a Cloudflare deployment build:

```bash
npm run check
```

After deployment, send a test post through the Telegram Bot API or wait for a new giveaway. A successful scheduled run with no newly added games intentionally produces no channel message.

## Configuration

The relevant values in `wrangler.jsonc` are:

- `STEAM_SEARCH_URL`: the permanent Steam giveaway search URL
- `TELEGRAM_CHANNEL_ID`: the public Telegram channel username
- `d1_databases`: the D1 binding and database ID
- `triggers.crons`: the hourly schedule (`0 * * * *`)

`database_id` is Cloudflare account-specific. Keeping it in a private repository is normal; for a public reusable template, replace it with a placeholder before publishing.
