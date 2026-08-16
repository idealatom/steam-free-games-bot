import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkGiveaways } from "../src/check-giveaways.js";
import { listOffers, reconcileOffers } from "../src/repository.js";
import { BREATHEDGE, MOONLIGHTER } from "./fixtures.js";

const NOW = 1_786_342_400_000;

function steamHtml(offers) {
  return offers
    .map(
      ({ appId, title }) => `
        <a class="search_result_row" data-ds-appid="${appId}">
          <span class="title">${title}</span>
          <div class="discount_pct">-100%</div>
        </a>`,
    )
    .join("");
}

function steamResponse(offers, totalCount = offers.length) {
  return new Response(
    JSON.stringify({
      success: 1,
      results_html: steamHtml(offers),
      total_count: totalCount,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mockRequests(steamResponses, telegramResponses = []) {
  const remainingSteam = [...steamResponses];
  const remainingTelegram = [...telegramResponses];
  const telegramBodies = [];
  const fetchStub = vi.fn(async (url, options) => {
    if (new URL(url).pathname === "/search/results/") {
      const response = remainingSteam.shift();
      return response instanceof Response ? response : steamResponse(response);
    }
    if (String(url).includes("api.telegram.org")) {
      telegramBodies.push(JSON.parse(options.body));
      return (
        remainingTelegram.shift() ??
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.stubGlobal("setTimeout", (callback) => {
    callback();
    return 0;
  });
  return { fetchStub, telegramBodies };
}

function testEnv() {
  return {
    DB: env.DB,
    STEAM_SEARCH_URL: env.STEAM_SEARCH_URL,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID: env.TELEGRAM_CHANNEL_ID,
  };
}

describe("hourly giveaway check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts all offers to the channel on the first non-empty scan", async () => {
    const { telegramBodies } = mockRequests([[MOONLIGHTER, BREATHEDGE]]);

    await checkGiveaways(testEnv(), NOW);

    expect(telegramBodies).toHaveLength(2);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: "@test_channel",
      photo:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/606150/header.jpg",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎮 Open in Steam", url: MOONLIGHTER.url }]],
      },
    });
    expect(telegramBodies[0].caption).toContain("Moonlighter");
    expect(telegramBodies[0].caption).not.toContain("Breathedge");
    expect(telegramBodies[1].caption).toContain("Breathedge");
    expect(telegramBodies[1].caption).not.toContain("Moonlighter");
    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER, BREATHEDGE]);
  });

  it("does not post an empty or unchanged scan", async () => {
    const { telegramBodies } = mockRequests([[], [], [MOONLIGHTER], [MOONLIGHTER]]);

    await checkGiveaways(testEnv(), NOW);
    await checkGiveaways(testEnv(), NOW + 1_000);
    await checkGiveaways(testEnv(), NOW + 2_000);
    await checkGiveaways(testEnv(), NOW + 3_000);

    expect(telegramBodies).toHaveLength(1);
  });

  it("posts only offers added since the preceding successful scan", async () => {
    const { telegramBodies } = mockRequests([
      [MOONLIGHTER],
      [MOONLIGHTER],
      [MOONLIGHTER, BREATHEDGE],
    ]);

    await checkGiveaways(testEnv(), NOW);
    await checkGiveaways(testEnv(), NOW + 1_000);
    await checkGiveaways(testEnv(), NOW + 2_000);

    expect(telegramBodies).toHaveLength(2);
    expect(telegramBodies[1].caption).toContain("New free Steam game:");
    expect(telegramBodies[1].caption).toContain("Breathedge");
    expect(telegramBodies[1].caption).not.toContain("Moonlighter");
  });

  it("does not post removals and posts an offer if it returns", async () => {
    const { telegramBodies } = mockRequests([
      [MOONLIGHTER],
      [],
      [MOONLIGHTER],
    ]);

    await checkGiveaways(testEnv(), NOW);
    await checkGiveaways(testEnv(), NOW + 1_000);
    await checkGiveaways(testEnv(), NOW + 2_000);

    expect(telegramBodies).toHaveLength(2);
  });

  it("publishes ten games as ten separate preview posts", async () => {
    const offers = Array.from({ length: 10 }, (_, index) => ({
      appId: 10_000 + index,
      title: `Game ${index + 1}`,
      url: `https://store.steampowered.com/app/${10_000 + index}/`,
    }));
    const { telegramBodies } = mockRequests([offers]);

    await checkGiveaways(testEnv(), NOW);

    expect(telegramBodies).toHaveLength(10);
    expect(
      telegramBodies.map(({ photo }) => photo),
    ).toEqual(
      offers.map(
        ({ appId }) =>
          `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
      ),
    );
    expect(telegramBodies.map(({ caption }) => caption)).toEqual(
      offers.map(
        ({ appId, title }) =>
          `<b>New free Steam game:</b>\n\n🎁 <a href="https://store.steampowered.com/app/${appId}/">${title}</a>`,
      ),
    );
  });

  it("leaves state unchanged if a later game post fails", async () => {
    const success = new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const failure = new Response(
      JSON.stringify({ ok: false, error_code: 500, description: "Unavailable" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
    const { telegramBodies } = mockRequests(
      [[MOONLIGHTER, BREATHEDGE]],
      [success, failure],
    );

    await expect(checkGiveaways(testEnv(), NOW)).rejects.toThrow("Unavailable");

    expect(telegramBodies).toHaveLength(2);
    expect(await listOffers(env.DB)).toEqual([]);
  });

  it("keeps offer state unchanged when Steam fails", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], NOW);
    mockRequests([new Response("unavailable", { status: 503 })]);

    await expect(checkGiveaways(testEnv(), NOW + 1_000)).rejects.toThrow(
      "Steam request failed with HTTP 503",
    );

    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER]);
  });

  it("saves state only after Telegram accepts the post, so failures retry", async () => {
    const telegramFailure = new Response(
      JSON.stringify({ ok: false, error_code: 500, description: "Unavailable" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
    const { telegramBodies } = mockRequests(
      [[MOONLIGHTER], [MOONLIGHTER]],
      [telegramFailure],
    );

    await expect(checkGiveaways(testEnv(), NOW)).rejects.toThrow("Unavailable");
    expect(await listOffers(env.DB)).toEqual([]);

    await checkGiveaways(testEnv(), NOW + 1_000);

    expect(telegramBodies).toHaveLength(2);
    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER]);
  });

  it("publishes more than ten new games as one linked list", async () => {
    const offers = Array.from({ length: 12 }, (_, index) => ({
      appId: 10_000 + index,
      title: `Game ${index + 1}`,
      url: `https://store.steampowered.com/app/${10_000 + index}/`,
    }));
    const { telegramBodies } = mockRequests([offers]);

    await checkGiveaways(testEnv(), NOW);
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: "@test_channel",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(telegramBodies[0].text).toContain("New free Steam games:");
    for (const offer of offers) {
      expect(telegramBodies[0].text).toContain(
        `<a href="${offer.url}">${offer.title}</a>`,
      );
    }
    expect(await listOffers(env.DB)).toEqual(offers);
  });

  it("balances multi-post lists instead of creating a one-game tail", async () => {
    const offers = Array.from({ length: 51 }, (_, index) => ({
      appId: 20_000 + index,
      title: `Game ${index + 1}`,
      url: `https://store.steampowered.com/app/${20_000 + index}/`,
    }));
    const firstPage = steamResponse(offers.slice(0, 50), offers.length);
    const secondPage = steamResponse(offers.slice(50), offers.length);
    const { telegramBodies } = mockRequests([
      firstPage,
      secondPage,
      firstPage.clone(),
      secondPage.clone(),
    ]);

    await checkGiveaways(testEnv(), NOW);

    expect(telegramBodies).toHaveLength(2);
    expect(
      telegramBodies.map(({ text }) => (text.match(/<a href=/g) ?? []).length),
    ).toEqual([26, 25]);
  });
});
