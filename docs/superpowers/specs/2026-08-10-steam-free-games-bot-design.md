# Steam Free Games Telegram Bot — Design

## Goal

Build a small public Telegram bot for friends. Any person can subscribe in a private chat with `/start`, unsubscribe with `/stop`, and receive newly discovered Steam giveaways. A new subscriber immediately receives the current giveaway list when it is not empty. Steam is checked once per hour. The solution must use free services and require no server administration.

The expected operating scale is no more than 30–40 subscribers. Supporting a large public audience is outside the initial scope.

## Architecture

A Cloudflare Worker provides two entry points:

- an HTTPS Telegram webhook handles subscription commands immediately;
- a Cron Trigger runs the Steam check once per hour.

Cloudflare D1 stores subscribers, the current Steam result, and successful per-subscriber deliveries. The Worker uses Cloudflare Secrets for the Telegram bot token and webhook secret. No GitHub Actions runner or continuously running process is required.

The design fits comfortably within the current Workers Free and D1 Free allowances for the expected scale. Relevant platform documentation:

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Telegram Bot API webhooks](https://core.telegram.org/bots/api#setwebhook)

## Components

- `src/index.js`: Cloudflare Worker `fetch` and `scheduled` entry points.
- `src/steam.js`: fetches and parses the configured Steam search result.
- `src/telegram.js`: validates Telegram responses and sends escaped messages.
- `src/subscriptions.js`: processes private-chat `/start` and `/stop` behavior.
- `src/check-giveaways.js`: reconciles Steam offers and delivers missing notifications.
- `migrations/`: D1 schema for subscribers, current offers, and deliveries.
- `test/`: behavior-focused tests running in the Cloudflare Workers test environment.
- `wrangler.jsonc`: Worker, D1 binding, secrets declarations, and hourly cron configuration.
- `README.md`: BotFather and Cloudflare setup, deployment, webhook registration, local tests, manual checks, and troubleshooting.

The production modules stay small and expose only functions used by another production module. Test-only fixtures and fakes remain in test files.

## Stored Data

D1 contains three tables:

- `subscribers`: Telegram chat ID and subscription timestamp;
- `offers`: the currently active Steam app ID, title, URL, and observation timestamp;
- `deliveries`: pairs of subscriber chat ID and app ID that were successfully delivered.

Primary keys prevent duplicate subscribers, offers, and deliveries. Foreign keys delete delivery rows when either the subscriber unsubscribes or an offer disappears.

An offer that remains active keeps its delivery records and is not sent twice. When an offer disappears, its row and delivery records are removed. If the same app later becomes free again, it is treated as a new giveaway and is delivered again.

## Subscription Flow

1. Telegram sends an HTTPS POST update to the Worker.
2. The Worker compares `X-Telegram-Bot-Api-Secret-Token` with its configured webhook secret before parsing or acting on the update.
3. Only commands from private chats are accepted.
4. `/start` inserts or retains the subscriber, sends a Russian confirmation, and sends the current offers in the same response flow when the list is not empty.
5. After the current-offers message succeeds, the Worker records those deliveries so the hourly job does not repeat them.
6. `/stop` removes the subscriber and confirms that notifications are disabled.
7. Unsupported messages receive a concise Russian help response describing `/start` and `/stop`.

Repeating `/start` is safe and shows the current giveaway list again when it is not empty. Telegram updates that lack a usable private-chat text message are acknowledged without side effects.

## Hourly Giveaway Flow

1. Cloudflare invokes the Worker's `scheduled` handler once per hour.
2. The Worker preserves the supplied filters but requests Steam's compact `/search/results/` JSON endpoint with a finite timeout and a normal browser user agent, avoiding the much larger full search page.
3. The parser accepts only valid game result rows with a numeric app ID, title, store URL, and explicit 100% discount.
4. The parser distinguishes a valid empty result from an unrecognized, blocked, or malformed response. An invalid response fails the run and leaves D1 unchanged.
5. The Worker removes offers no longer present and upserts all current offers using an atomic D1 batch. Unchanged offers retain their delivery rows.
6. For each subscriber, the Worker finds current offers without matching delivery rows and sends them together in one Russian Telegram message.
7. Only after that subscriber's message succeeds does the Worker insert the corresponding delivery rows.
8. If there are no missing deliveries, the run sends nothing.

The initial successful Steam check treats every current offer as new for existing subscribers. If no one has subscribed yet, it still caches the active offers so a later `/start` can show them immediately.

## Telegram Delivery Behavior

Messages contain a short heading followed by linked game titles. Dynamic titles are HTML-escaped, and store links are constructed from validated numeric Steam app IDs.

Delivery is performed in small sequential batches suitable for the expected 30–40-person audience. Telegram rate-limit responses honor the returned retry delay for one bounded retry. A `403` response means the user blocked the bot; that subscriber is removed and does not fail delivery to others. Other failed deliveries remain unrecorded and are retried on the next scheduled run without duplicating already successful recipients.

## Configuration and Secrets

Non-secret configuration includes the Steam search URL, hourly cron expression, D1 binding, and supported command names.

Cloudflare Secrets contain:

- `TELEGRAM_BOT_TOKEN`: token issued by BotFather;
- `TELEGRAM_WEBHOOK_SECRET`: random value configured in both the Worker and Telegram webhook.

The bot token never appears in repository files or application logs and is used only in outbound Telegram API requests. The webhook endpoint accepts only POST requests and never logs complete Telegram updates or chat IDs.

## Error Handling

- Steam network, timeout, HTTP, and unsafe-parse failures leave the offer snapshot and deliveries unchanged.
- A valid Steam page with no matching giveaways clears the active offers without notifying subscribers.
- D1 errors fail the current request or scheduled run visibly.
- Telegram failures never create false delivery records.
- A failure after some recipients were notified retries only recipients lacking delivery records.
- Malformed or unauthenticated webhook requests cause no database writes or Telegram calls.

Exactly-once delivery cannot be guaranteed across an external Telegram success followed by a D1 write failure, but delivery records minimize duplicates and prevent loss during ordinary retries.

## Testing and Acceptance Criteria

Tests use saved minimal Steam HTML and fake external responses; routine test runs do not depend on live Steam or Telegram availability. Production entry points are exercised in the Cloudflare Workers test environment with an isolated D1 database.

The implementation is accepted when:

- a private-chat `/start` subscribes immediately and confirms success;
- `/start` sends current offers only when the stored list is non-empty;
- repeated `/start` does not duplicate the subscriber;
- `/stop` removes the subscriber and future notifications stop;
- invalid webhook secrets and non-private updates have no side effects;
- the first successful Steam check delivers all current offers to existing subscribers;
- later checks deliver only offers without successful delivery records;
- removed games produce no notification;
- an offer that disappears and later returns is delivered again;
- only explicit 100%-discount game rows are accepted;
- malformed or blocked Steam responses do not overwrite state;
- successful recipients do not receive duplicates when another recipient fails;
- blocked users are removed;
- automated tests and deployment configuration validation pass using documented commands.

## Non-goals

- Notifications when a giveaway ends.
- Group-chat subscriptions, administrator approval, user accounts, or preferences.
- A web dashboard or Telegram command menu beyond `/start` and `/stop`.
- Large-audience queueing or broadcast infrastructure.
- Price-history verification beyond Steam's current search result.
