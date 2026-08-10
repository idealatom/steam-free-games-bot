# Steam Free Games Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a free Cloudflare Worker Telegram bot that immediately manages private subscriptions and checks Steam hourly for new 100%-discount giveaways.

**Architecture:** Telegram calls a secret-validated Worker webhook for `/start` and `/stop`; a Cloudflare Cron Trigger calls a scheduled handler hourly. D1 stores subscribers, the current offer snapshot, and successful per-user deliveries so retries do not duplicate successful notifications.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers, D1, `entities` 8.0.0, Wrangler 4.120.0, Vitest 4.1.10, `@cloudflare/vitest-pool-workers` 0.20.3, Node.js 22 or newer.

## Global Constraints

- Support private Telegram chats only and an expected maximum of 30–40 subscribers.
- `/start` subscribes immediately and sends current offers only when the list is non-empty; `/stop` unsubscribes immediately.
- Check the supplied Steam search URL once per hour and notify only missing per-user deliveries.
- Accept only search rows explicitly marked with a 100% discount.
- Never notify when an offer disappears; notify again if the same app disappears and later returns.
- Preserve D1 state after unrecognized, blocked, malformed, timeout, or HTTP-failed Steam responses.
- Store the Telegram bot token and webhook secret only as Cloudflare Secrets.
- Use small production modules, no duplicated D1 queries or Telegram request logic, and no production seams created only for tests.
- Use strict red-green-refactor TDD for every behavior change.

---

## File Map

- `package.json`: exact local tooling and test/config scripts.
- `package-lock.json`: reproducible dependency resolution.
- `wrangler.jsonc`: Worker entry point, compatibility date, D1 binding, Steam URL, and hourly cron.
- `vitest.config.js`: Workers test runtime, D1 migrations binding, and setup file.
- `migrations/0001_initial.sql`: subscribers, offers, deliveries, foreign keys, and indexes.
- `test/apply-migrations.js`: applies real D1 migrations to each isolated test database.
- `test/fixtures.js`: complete Steam and Telegram boundary fixtures used by multiple test files.
- `src/repository.js`: all D1 reads and writes.
- `src/steam.js`: Steam HTTP request and HTML parsing.
- `src/telegram.js`: message formatting, Bot API transport, bounded rate-limit retry, and typed errors.
- `src/subscriptions.js`: private-chat command behavior.
- `src/check-giveaways.js`: offer reconciliation and pending-delivery broadcast.
- `src/index.js`: secret-validated Worker `fetch` and `scheduled` entry points.
- `test/repository.test.js`: persistence, cascade, and pending-delivery behavior.
- `test/steam.test.js`: accepted, empty, duplicate, malformed, and HTTP-failure Steam behavior.
- `test/telegram.test.js`: escaping, outbound payload, retry, and Telegram error behavior.
- `test/subscriptions.test.js`: `/start`, repeated `/start`, `/stop`, help, and private-chat behavior.
- `test/check-giveaways.test.js`: first scan, new-only, removal/reappearance, partial failure, and blocked-user behavior.
- `test/worker.test.js`: webhook authentication/method validation and scheduled entry-point behavior.
- `README.md`: complete setup, deployment, webhook registration, test, and troubleshooting guide.
- `.gitignore`: dependency, Wrangler state, coverage, and local secret files.

---

### Task 1: Local Tooling, D1 Schema, and Repository

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `.gitignore`
- Create: `wrangler.jsonc`
- Create: `vitest.config.js`
- Create: `migrations/0001_initial.sql`
- Create: `test/apply-migrations.js`
- Create: `test/repository.test.js`
- Create: `src/repository.js`

**Interfaces:**
- Produces: `subscribe(db, chatId)`, `unsubscribe(db, chatId)`, `listOffers(db)`, `reconcileOffers(db, offers, observedAt)`, `listPendingBySubscriber(db)`, and `markDelivered(db, chatId, appIds)`.
- Offer shape: `{ appId: number, title: string, url: string }`.
- Pending shape: `Map<number, Offer[]>` keyed by Telegram chat ID.

- [ ] **Step 1: Add minimal tool configuration**

Create `package.json` with private ESM configuration, Node `>=22`, scripts `test`, `test:watch`, `check` (`npm test && npx wrangler deploy --dry-run`), exact dev dependencies Wrangler 4.120.0, Vitest 4.1.10, and Workers pool 0.20.3, plus `entities` 8.0.0 for standards-complete Steam title decoding. Create `wrangler.jsonc` with `main: "src/index.js"`, compatibility date `2026-08-08` (the newest date supported by the locked runtime), a local D1 ID, `STEAM_SEARCH_URL`, and cron `0 * * * *`. Configure Vitest with `cloudflareTest`, `readD1Migrations`, a `TEST_MIGRATIONS` binding, and `test/apply-migrations.js`.

Use this schema:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE subscribers (
  chat_id INTEGER PRIMARY KEY,
  subscribed_at INTEGER NOT NULL
);

CREATE TABLE offers (
  app_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  chat_id INTEGER NOT NULL REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES offers(app_id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, app_id)
);

CREATE INDEX deliveries_app_id ON deliveries(app_id);
```

- [ ] **Step 2: Install locked development dependencies**

Run: `npm install`

Expected: `package-lock.json` is created with only `entities` as a direct runtime dependency and npm exits successfully.

- [ ] **Step 3: Write failing repository tests**

Write behavior tests using real `env.DB`:

```js
it("lists each undelivered offer under each subscriber", async () => {
  await subscribe(env.DB, 101);
  await subscribe(env.DB, 202);
  await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);

  const pending = await listPendingBySubscriber(env.DB);

  expect([...pending]).toEqual([
    [101, [MOONLIGHTER]],
    [202, [MOONLIGHTER]],
  ]);
});

it("keeps deliveries for unchanged offers and removes them with ended offers", async () => {
  await subscribe(env.DB, 101);
  await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
  await markDelivered(env.DB, 101, [MOONLIGHTER.appId]);
  await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_346_000);
  expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());

  await reconcileOffers(env.DB, [], 1_786_349_600);
  await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_353_200);
  expect([...await listPendingBySubscriber(env.DB)]).toEqual([[101, [MOONLIGHTER]]]);
});
```

Also cover idempotent subscription, unsubscribe cascade, stable sort by `app_id`, and empty `markDelivered` as a no-op.

- [ ] **Step 4: Run repository tests and verify RED**

Run: `npm test -- test/repository.test.js`

Expected: FAIL because `src/repository.js` does not exist.

- [ ] **Step 5: Implement the minimal repository**

Use prepared statements only. `reconcileOffers` must first read existing app IDs, then execute one atomic `db.batch()` containing deletes for absent IDs and `INSERT ... ON CONFLICT DO UPDATE` statements for current IDs. Do not delete and recreate unchanged offers, because that would cascade their deliveries. `listPendingBySubscriber` uses one ordered join and groups rows into a `Map` in JavaScript.

Required signatures:

```js
export async function subscribe(db, chatId, subscribedAt = Date.now()) {}
export async function unsubscribe(db, chatId) {}
export async function listOffers(db) {}
export async function reconcileOffers(db, offers, observedAt = Date.now()) {}
export async function listPendingBySubscriber(db) {}
export async function markDelivered(db, chatId, appIds, deliveredAt = Date.now()) {}
```

The timestamp parameters are production-useful event timestamps supplied by callers, not test-only switches.

- [ ] **Step 6: Run repository tests and verify GREEN**

Run: `npm test -- test/repository.test.js`

Expected: all repository tests PASS with no warnings.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore wrangler.jsonc vitest.config.js migrations/0001_initial.sql test/apply-migrations.js test/repository.test.js src/repository.js
git commit -m "feat: add D1 giveaway repository"
```

---

### Task 2: Steam Search Fetching and Parsing

**Files:**
- Create: `test/fixtures.js`
- Create: `test/steam.test.js`
- Create: `src/steam.js`

**Interfaces:**
- Produces: `parseSteamOffers(html): Promise<Offer[]>` and `fetchSteamOffers(url): Promise<Offer[]>`; the latter preserves the supplied filters while deriving Steam's compact `/search/results/` JSON endpoint.
- Consumes: the Offer shape from Task 1.

- [ ] **Step 1: Write failing parser tests**

Use hand-written complete fragments containing a recognizable `#search_resultsRows` container. Cover two valid rows, a row with `-90%`, a free-to-play row without a discount, duplicate `data-ds-appid`, HTML entities/chunked title text, and a valid empty container.

```js
it("keeps only explicit 100 percent Steam game discounts", async () => {
  expect(await parseSteamOffers(STEAM_RESULTS_HTML)).toEqual([
    { appId: 606150, title: "Moonlighter", url: "https://store.steampowered.com/app/606150/" },
    { appId: 738520, title: "Breathedge", url: "https://store.steampowered.com/app/738520/" },
  ]);
});

it("accepts a recognizable empty result", async () => {
  await expect(parseSteamOffers('<div id="search_resultsRows"></div>')).resolves.toEqual([]);
});

it("rejects an unrecognized response instead of treating it as empty", async () => {
  await expect(parseSteamOffers("<html>Access denied</html>"))
    .rejects.toThrow("Steam response is not a search result");
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npm test -- test/steam.test.js`

Expected: FAIL because `src/steam.js` does not exist.

- [ ] **Step 3: Implement streaming parsing with `HTMLRewriter`**

Register handlers for the results container, each `a.search_result_row`, nested `.title`, and nested `.discount_pct`. Validate `data-ds-appid` with `/^[1-9]\d*$/`, normalize whitespace, require the exact trimmed discount `-100%`, deduplicate by app ID, sort by app ID, and construct the canonical URL from the numeric ID rather than trusting Steam HTML.

Do not accept an empty array unless the recognizable results container was observed.

- [ ] **Step 4: Add a failing HTTP boundary test**

Use a Vitest global `fetch` boundary stub to verify the compact endpoint, preservation of the supplied `maxprice`, `category1`, and `specials` filters, a browser-like user agent, non-2xx rejection, JSON contract validation, reported-count validation, and parsing of a successful body. The production request must use `AbortSignal.timeout(15_000)`. The locked Workers pool no longer exports the older `fetchMock` helper.

- [ ] **Step 5: Implement `fetchSteamOffers` and verify GREEN**

Run: `npm test -- test/steam.test.js`

Expected: all Steam tests PASS and no real network request is made.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures.js test/steam.test.js src/steam.js
git commit -m "feat: parse Steam giveaway results"
```

---

### Task 3: Telegram Formatting and Transport

**Files:**
- Create: `test/telegram.test.js`
- Create: `src/telegram.js`

**Interfaces:**
- Produces: `formatOffersMessage(offers, heading)`, `sendTelegramMessage(env, chatId, text)`, and `TelegramError` with `status` and `retryAfter` properties.
- Consumes: Offer arrays from Tasks 1–2 and environment secret `TELEGRAM_BOT_TOKEN`.

- [ ] **Step 1: Write failing formatting tests**

```js
it("escapes titles and emits canonical Steam links", () => {
  expect(formatOffersMessage([
    { appId: 7, title: "A < B & C", url: "https://ignored.example" },
  ], "New free game:"))
    .toBe('<b>New free game:</b>\n\n• <a href="https://store.steampowered.com/app/7/">A &lt; B &amp; C</a>');
});
```

Also cover plural headings passed by the caller and an empty array throwing instead of sending a blank Telegram message.

- [ ] **Step 2: Run formatting tests and verify RED**

Run: `npm test -- test/telegram.test.js`

Expected: FAIL because `src/telegram.js` does not exist.

- [ ] **Step 3: Implement minimal formatting and Bot API transport**

POST JSON to `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage` with `chat_id`, `text`, `parse_mode: "HTML"`, and link previews disabled. Treat either non-2xx HTTP or Telegram `{ ok: false }` JSON as `TelegramError`. Never log the request URL or body.

- [ ] **Step 4: Add failing transport tests**

Use a Vitest global `fetch` boundary stub to assert the observable request payload and to cover success, `403`, ordinary `500`, and `429` with `parameters.retry_after: 1`. For `429`, use fake timers and assert exactly one retry, then success. The test catches removing the retry branch or retrying without its bounded limit.

- [ ] **Step 5: Implement one bounded `429` retry and verify GREEN**

Run: `npm test -- test/telegram.test.js`

Expected: all Telegram tests PASS with no real network access.

- [ ] **Step 6: Commit**

```bash
git add test/telegram.test.js src/telegram.js
git commit -m "feat: add Telegram message delivery"
```

---

### Task 4: Immediate Subscription Commands

**Files:**
- Create: `test/subscriptions.test.js`
- Create: `src/subscriptions.js`

**Interfaces:**
- Produces: `handleTelegramUpdate(env, update): Promise<void>`.
- Consumes: repository functions from Task 1 and Telegram functions from Task 3.

- [ ] **Step 1: Write failing `/start` behavior tests**

Use real D1 and a global `fetch` boundary stub for Telegram. A complete update fixture contains `update_id`, `message.message_id`, `message.chat.id`, `message.chat.type`, `message.date`, and `message.text`.

```js
it("subscribes a private chat and immediately sends cached offers", async () => {
  await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);

  await handleTelegramUpdate(env, privateCommand(101, "/start"));

  expect(await env.DB.prepare("SELECT chat_id FROM subscribers").first("chat_id")).toBe(101);
  expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());
  // Captured Telegram request bodies must contain the confirmation and one current-offers message.
});
```

Add separate tests for an empty offer list (confirmation only), repeated `/start` (one subscriber, current list intentionally shown again), `/start@BotName`, `/stop` cascade and confirmation, unknown text help, and non-private/no-text updates with no DB or Telegram side effects.

- [ ] **Step 2: Run subscription tests and verify RED**

Run: `npm test -- test/subscriptions.test.js`

Expected: FAIL because `src/subscriptions.js` does not exist.

- [ ] **Step 3: Implement private command handling**

Normalize only the first whitespace-delimited token to lowercase and remove an optional `@username` suffix. For `/start`, subscribe first, send confirmation, list current offers, send them only when non-empty, then mark them delivered. For `/stop`, unsubscribe before confirming. Unsupported private text receives help. Ignore all other updates.

- [ ] **Step 4: Run subscription tests and verify GREEN**

Run: `npm test -- test/subscriptions.test.js`

Expected: all subscription tests PASS.

- [ ] **Step 5: Commit**

```bash
git add test/subscriptions.test.js src/subscriptions.js
git commit -m "feat: manage Telegram subscriptions"
```

---

### Task 5: Hourly Offer Reconciliation and Broadcast

**Files:**
- Create: `test/check-giveaways.test.js`
- Create: `src/check-giveaways.js`

**Interfaces:**
- Produces: `checkGiveaways(env, observedAt): Promise<void>`.
- Consumes: `fetchSteamOffers`, all repository reconciliation/delivery functions, `formatOffersMessage`, `sendTelegramMessage`, and `TelegramError`.

- [ ] **Step 1: Write failing successful-flow tests**

Use real D1 plus mocked Steam and Telegram HTTP boundaries. Test:

```js
it("delivers every offer on the first successful scan", async () => {
  await subscribe(env.DB, 101);
  mockSteam([MOONLIGHTER, BREATHEDGE]);
  mockTelegramSuccess(101);

  await checkGiveaways(env, 1_786_342_400);

  expect(await listOffers(env.DB)).toEqual([MOONLIGHTER, BREATHEDGE]);
  expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());
});
```

Add tests proving unchanged offers send nothing, only a newly added app is sent, a removed app sends nothing, and a removed-then-returned app is sent again.

- [ ] **Step 2: Run check tests and verify RED**

Run: `npm test -- test/check-giveaways.test.js`

Expected: FAIL because `src/check-giveaways.js` does not exist.

- [ ] **Step 3: Implement successful reconciliation and delivery**

Fetch first. Only after parsing succeeds, call `reconcileOffers`. Query pending offers once, format one message per subscriber, deliver sequentially, and mark that subscriber's app IDs only after success.

- [ ] **Step 4: Add failing failure-safety tests**

Test that a malformed or HTTP-failed Steam response leaves the previous `offers` and `deliveries` unchanged. With two subscribers, make the first Telegram call succeed and the second fail with `500`; assert the first has no pending rows and the second remains pending. Make a `403` response remove only that subscriber and allow the run to continue.

- [ ] **Step 5: Implement failure isolation and aggregate reporting**

Catch `TelegramError` per subscriber. On `403`, unsubscribe and continue. Record other errors, continue remaining recipients, then throw one `AggregateError` after all recipients have been attempted so the Cron run is visibly failed. Already successful delivery records remain committed and suppress duplicates on retry.

- [ ] **Step 6: Run check tests and verify GREEN**

Run: `npm test -- test/check-giveaways.test.js`

Expected: all check tests PASS.

- [ ] **Step 7: Commit**

```bash
git add test/check-giveaways.test.js src/check-giveaways.js
git commit -m "feat: broadcast new Steam giveaways"
```

---

### Task 6: Worker Webhook and Scheduled Entry Points

**Files:**
- Create: `test/worker.test.js`
- Create: `src/index.js`

**Interfaces:**
- Produces: default Worker export with `fetch(request, env, ctx): Promise<Response>` and `scheduled(controller, env, ctx): Promise<void>`.
- Consumes: `handleTelegramUpdate` and `checkGiveaways`.

- [ ] **Step 1: Write failing webhook boundary tests**

Call the real Worker through `SELF.fetch`. Verify:

- `GET` returns `405` and `Allow: POST`;
- missing or wrong `X-Telegram-Bot-Api-Secret-Token` returns `401` without DB/Telegram effects;
- invalid JSON returns `400` without effects;
- a valid secret plus `/start` returns `200` and subscribes;
- a valid unsupported update returns `200` without side effects.

- [ ] **Step 2: Run worker tests and verify RED**

Run: `npm test -- test/worker.test.js`

Expected: FAIL because `src/index.js` does not exist.

- [ ] **Step 3: Implement the minimal authenticated webhook**

Require POST before reading the body. Compare the exact secret header to non-empty `env.TELEGRAM_WEBHOOK_SECRET`. Parse JSON, call `handleTelegramUpdate`, and return an empty `204` on success. Do not log the update or chat ID.

- [ ] **Step 4: Add and pass the scheduled entry-point test**

Invoke the exported scheduled handler with a fixed `scheduledTime`, mocked Steam response, real D1, and mocked Telegram response. Assert the stored `observed_at` equals the controller time and the notification is delivered. Implement `scheduled` as a direct call to `checkGiveaways(env, controller.scheduledTime)` so failures remain visible to Cloudflare.

Run: `npm test -- test/worker.test.js`

Expected: all Worker tests PASS.

- [ ] **Step 5: Commit**

```bash
git add test/worker.test.js src/index.js
git commit -m "feat: expose Telegram webhook and hourly check"
```

---

### Task 7: Deployment Guide and Complete Verification

**Files:**
- Create: `README.md`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: the complete deployable Worker from Tasks 1–6.
- Produces: reproducible setup and operation instructions for the owner.

- [ ] **Step 1: Write the complete setup guide**

Document these exact actions in order:

1. prerequisites: Node.js 22+, npm, free Cloudflare account, Telegram bot from BotFather;
2. `npm install` and `npx wrangler login`;
3. `npx wrangler d1 create steam-free-games-bot`, then replace the local D1 ID in `wrangler.jsonc` with the returned UUID;
4. `npx wrangler d1 migrations apply steam-free-games-bot --remote`;
5. `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` using a random value containing only Telegram-supported secret characters;
6. `npm test`, `npm run check`, and `npx wrangler deploy`;
7. register the HTTPS Worker URL with Telegram `setWebhook`, passing `secret_token` and `allowed_updates: ["message"]` without placing the bot token into shell history (use a prompted shell variable or a short script that reads from stdin);
8. verify with Telegram `getWebhookInfo`, send `/start`, and manually trigger the scheduled handler locally or from Cloudflare observability;
9. explain `/start`, `/stop`, first empty-cache behavior, hourly checks, 403 cleanup, retry semantics, and how to inspect sanitized Worker logs;
10. rollback instructions: deploy the previous Git commit; D1 migrations in this version are additive and need no destructive rollback.

- [ ] **Step 2: Validate documentation commands locally where safe**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run check`

Expected: tests PASS and Wrangler dry-run builds the Worker successfully without contacting live Steam or Telegram.

- [ ] **Step 3: Inspect final scope and formatting**

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: only `README.md` and any intentional final configuration adjustment are uncommitted.

- [ ] **Step 4: Commit**

```bash
git add README.md wrangler.jsonc
git commit -m "docs: add Cloudflare deployment guide"
```

- [ ] **Step 5: Final verification from a clean tree**

Run: `npm test && npm run check && git status --short`

Expected: both commands exit `0`, the dry-run bundle succeeds, and Git status is empty.

The owner must still perform Cloudflare login, create the remote D1 database, set the two secrets, deploy, and register the Telegram webhook because those actions require their external account and credentials.
