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

function steamResponse(offers) {
  return new Response(
    JSON.stringify({
      success: 1,
      results_html: steamHtml(offers),
      total_count: offers.length,
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

    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: "@test_channel",
      parse_mode: "HTML",
    });
    expect(telegramBodies[0].text).toContain("New free Steam games:");
    expect(telegramBodies[0].text).toContain("Moonlighter");
    expect(telegramBodies[0].text).toContain("Breathedge");
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
    expect(telegramBodies[1].text).toContain("New free Steam game:");
    expect(telegramBodies[1].text).toContain("Breathedge");
    expect(telegramBodies[1].text).not.toContain("Moonlighter");
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

  it("uses one Telegram request even when ten games appear", async () => {
    const offers = Array.from({ length: 10 }, (_, index) => ({
      appId: 10_000 + index,
      title: `Game ${index + 1}`,
      url: `https://store.steampowered.com/app/${10_000 + index}/`,
    }));
    const { telegramBodies } = mockRequests([offers]);

    await checkGiveaways(testEnv(), NOW);

    expect(telegramBodies).toHaveLength(1);
    for (const offer of offers) {
      expect(telegramBodies[0].text).toContain(offer.title);
    }
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
});
