import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkGiveaways } from "../src/check-giveaways.js";
import { reconcileOffers, subscribe } from "../src/repository.js";
import { BREATHEDGE, MOONLIGHTER } from "./fixtures.js";

const NOW = 1_786_342_400_000;

function steamHtml(offers) {
  return `<div id="search_resultsRows">${offers
    .map(
      ({ appId, title }) => `
        <a class="search_result_row" data-ds-appid="${appId}">
          <span class="title">${title}</span>
          <div class="discount_pct">-100%</div>
        </a>`,
    )
    .join("")}</div>`;
}

function mockSteam(responses) {
  const remaining = [...responses];
  const fetchStub = vi.fn(async (url) => {
    if (new URL(url).pathname !== "/search/results/") {
      throw new Error(`Unexpected direct request: ${url}`);
    }
    const response = remaining.shift();
    if (response instanceof Response) {
      return response;
    }
    const payload =
      typeof response === "string"
        ? {
            success: 1,
            results_html: response,
            total_count: (response.match(/search_result_row/g) ?? []).length,
          }
        : response;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

function fakeQueue(sendBatch = async () => undefined) {
  const batches = [];
  return {
    batches,
    async sendBatch(messages) {
      batches.push(messages);
      return sendBatch(messages, batches.length);
    },
  };
}

function testEnv(queue) {
  return {
    DB: env.DB,
    STEAM_SEARCH_URL: env.STEAM_SEARCH_URL,
    NOTIFICATION_QUEUE: queue,
  };
}

async function addSubscribers(count, subscribedAt = NOW - 1) {
  await env.DB.batch(
    Array.from({ length: count }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO subscribers (chat_id, subscribed_at) VALUES (?, ?)",
      ).bind(index + 1, subscribedAt),
    ),
  );
}

describe("hourly giveaway check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns ten new offers and one hundred subscribers into one event and one hundred jobs", async () => {
    await addSubscribers(100);
    const offers = Array.from({ length: 10 }, (_, index) => ({
      appId: 10_000 + index,
      title: `Game ${index + 1}`,
      url: `https://store.steampowered.com/app/${10_000 + index}/`,
    }));
    const queue = fakeQueue();
    const fetchStub = mockSteam([steamHtml(offers)]);

    await checkGiveaways(testEnv(queue), NOW);

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(queue.batches).toHaveLength(1);
    expect(queue.batches[0]).toHaveLength(100);
    expect(
      new Set(queue.batches[0].map(({ body }) => body.eventId)).size,
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_events",
      ).first("count"),
    ).toBe(1);
  });

  it("chunks more than one hundred jobs into valid Queue batches", async () => {
    await addSubscribers(205);
    const queue = fakeQueue();
    mockSteam([steamHtml([MOONLIGHTER])]);

    await checkGiveaways(testEnv(queue), NOW);

    expect(queue.batches.map(({ length }) => length)).toEqual([100, 100, 5]);
  });

  it("queues only the newly added offer after an unchanged scan", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    const queue = fakeQueue();
    mockSteam([
      steamHtml([MOONLIGHTER]),
      steamHtml([MOONLIGHTER]),
      steamHtml([MOONLIGHTER, BREATHEDGE]),
    ]);

    await checkGiveaways(testEnv(queue), NOW);
    await checkGiveaways(testEnv(queue), NOW + 1_000);
    await checkGiveaways(testEnv(queue), NOW + 2_000);

    expect(queue.batches).toHaveLength(2);
    const { results } = await env.DB.prepare(
      "SELECT offers_json FROM notification_events ORDER BY id",
    ).all();
    expect(results.map(({ offers_json: json }) => JSON.parse(json))).toEqual([
      [MOONLIGHTER],
      [BREATHEDGE],
    ]);
  });

  it("does not queue removals and creates a new event if the offer returns", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    const queue = fakeQueue();
    mockSteam([
      steamHtml([MOONLIGHTER]),
      steamHtml([]),
      steamHtml([MOONLIGHTER]),
    ]);

    await checkGiveaways(testEnv(queue), NOW);
    await checkGiveaways(testEnv(queue), NOW + 1_000);
    await checkGiveaways(testEnv(queue), NOW + 2_000);

    expect(queue.batches).toHaveLength(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_events",
      ).first("count"),
    ).toBe(2);
  });

  it("leaves an event pending when Queue publishing fails", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    const queue = fakeQueue(async () => {
      throw new Error("Queue unavailable");
    });
    mockSteam([steamHtml([MOONLIGHTER])]);

    await expect(checkGiveaways(testEnv(queue), NOW)).rejects.toThrow(
      "Queue unavailable",
    );

    expect(
      await env.DB.prepare(
        "SELECT dispatched_at FROM notification_events",
      ).first("dispatched_at"),
    ).toBeNull();
  });

  it("republishes only missing deliveries after an hour", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    await subscribe(env.DB, 202, NOW - 1);
    const queue = fakeQueue();
    mockSteam([steamHtml([MOONLIGHTER]), steamHtml([MOONLIGHTER])]);

    await checkGiveaways(testEnv(queue), NOW);
    const eventId = queue.batches[0][0].body.eventId;
    await env.DB.prepare(
      `INSERT INTO notification_deliveries (event_id, chat_id, delivered_at)
       VALUES (?, ?, ?)`,
    )
      .bind(eventId, 101, NOW + 1)
      .run();
    await checkGiveaways(testEnv(queue), NOW + 60 * 60 * 1_000);

    expect(queue.batches).toHaveLength(2);
    expect(queue.batches[1].map(({ body }) => body)).toEqual([
      { eventId, chatId: 202 },
    ]);
  });

  it("repairs a pending event even when the current Steam scan fails", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    const eventId = await reconcileOffers(env.DB, [MOONLIGHTER], NOW);
    const queue = fakeQueue();
    mockSteam([new Response("unavailable", { status: 503 })]);

    await expect(checkGiveaways(testEnv(queue), NOW + 1_000)).rejects.toThrow(
      "Steam request failed with HTTP 503",
    );

    expect(queue.batches).toHaveLength(1);
    expect(queue.batches[0].map(({ body }) => body)).toEqual([
      { eventId, chatId: 101 },
    ]);
  });

  it("does not change state after a failed or unrecognized Steam response", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], NOW);
    const queue = fakeQueue();
    mockSteam([
      {
        success: 1,
        results_html: "<html>unknown markup</html>",
        total_count: 1,
      },
      new Response("unavailable", { status: 503 }),
    ]);

    await expect(checkGiveaways(testEnv(queue), NOW + 1_000)).rejects.toThrow(
      "Steam result rows do not match the reported count",
    );
    await expect(checkGiveaways(testEnv(queue), NOW + 2_000)).rejects.toThrow(
      "Steam request failed with HTTP 503",
    );

    expect(queue.batches).toHaveLength(0);
  });
});
