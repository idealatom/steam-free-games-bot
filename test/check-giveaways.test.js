import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkGiveaways } from "../src/check-giveaways.js";
import {
  listOffers,
  listPendingBySubscriber,
  markDelivered,
  reconcileOffers,
  subscribe,
} from "../src/repository.js";
import {
  BREATHEDGE,
  MOONLIGHTER,
} from "./fixtures.js";

function steamHtml(offers) {
  const rows = offers
    .map(
      ({ appId, title }) => `
        <a class="search_result_row" data-ds-appid="${appId}">
          <span class="title">${title}</span>
          <div class="discount_pct">-100%</div>
        </a>`,
    )
    .join("");
  return `<div id="search_resultsRows">${rows}</div>`;
}

function mockServices({ steamResponses, telegramResponse } = {}) {
  const responses = [...steamResponses];
  const telegramMessages = [];
  const fetchStub = vi.fn(async (url, options) => {
    if (new URL(url).pathname === "/search/results/") {
      const response = responses.shift();
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
    }

    if (String(url).startsWith("https://api.telegram.org/")) {
      const payload = JSON.parse(options.body);
      telegramMessages.push(payload);
      if (telegramResponse) {
        return telegramResponse(payload, telegramMessages.length);
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchStub);
  return { fetchStub, telegramMessages };
}

function telegramError(status, description) {
  return new Response(
    JSON.stringify({ ok: false, error_code: status, description }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("hourly giveaway check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("delivers every offer on the first successful scan", async () => {
    await subscribe(env.DB, 101);
    const { telegramMessages } = mockServices({
      steamResponses: [steamHtml([MOONLIGHTER, BREATHEDGE])],
    });

    await checkGiveaways(env, 1_786_342_400);

    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER, BREATHEDGE]);
    expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());
    expect(telegramMessages).toHaveLength(1);
    expect(telegramMessages[0]).toMatchObject({ chat_id: 101 });
    expect(telegramMessages[0].text).toContain("Moonlighter");
    expect(telegramMessages[0].text).toContain("Breathedge");
  });

  it("sends only an app added after an unchanged scan", async () => {
    await subscribe(env.DB, 101);
    const { telegramMessages } = mockServices({
      steamResponses: [
        steamHtml([MOONLIGHTER]),
        steamHtml([MOONLIGHTER]),
        steamHtml([MOONLIGHTER, BREATHEDGE]),
      ],
    });

    await checkGiveaways(env, 1_786_342_400);
    await checkGiveaways(env, 1_786_346_000);
    await checkGiveaways(env, 1_786_349_600);

    expect(telegramMessages).toHaveLength(2);
    expect(telegramMessages[1].text).toContain("Breathedge");
    expect(telegramMessages[1].text).not.toContain("Moonlighter");
  });

  it("does not notify on removal and notifies if the app later returns", async () => {
    await subscribe(env.DB, 101);
    const { telegramMessages } = mockServices({
      steamResponses: [
        steamHtml([MOONLIGHTER]),
        steamHtml([]),
        steamHtml([MOONLIGHTER]),
      ],
    });

    await checkGiveaways(env, 1_786_342_400);
    await checkGiveaways(env, 1_786_346_000);
    expect(await listOffers(env.DB)).toEqual([]);
    await checkGiveaways(env, 1_786_349_600);

    expect(telegramMessages).toHaveLength(2);
    expect(telegramMessages.every(({ text }) => text.includes("Moonlighter"))).toBe(
      true,
    );
  });

  it("leaves state untouched after an unrecognized Steam response", async () => {
    await subscribe(env.DB, 101);
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    await markDelivered(env.DB, 101, [MOONLIGHTER.appId]);
    mockServices({
      steamResponses: [
        {
          success: 1,
          results_html: "<html>unknown markup</html>",
          total_count: 1,
        },
      ],
    });

    await expect(checkGiveaways(env, 1_786_346_000)).rejects.toThrow(
      "Steam result rows do not match the reported count",
    );

    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER]);
    expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());
  });

  it("leaves state untouched after a failed Steam request", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    mockServices({
      steamResponses: [new Response("unavailable", { status: 503 })],
    });

    await expect(checkGiveaways(env, 1_786_346_000)).rejects.toThrow(
      "Steam request failed with HTTP 503",
    );

    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER]);
  });

  it("keeps only the failed recipient pending after a partial delivery", async () => {
    await subscribe(env.DB, 101);
    await subscribe(env.DB, 202);
    mockServices({
      steamResponses: [steamHtml([MOONLIGHTER])],
      telegramResponse(payload) {
        if (payload.chat_id === 202) {
          return telegramError(500, "Internal error");
        }
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(checkGiveaways(env, 1_786_342_400)).rejects.toThrow(
      "Failed to notify some subscribers",
    );

    expect([...await listPendingBySubscriber(env.DB)]).toEqual([
      [202, [MOONLIGHTER]],
    ]);
  });

  it("removes a blocked subscriber and continues delivering", async () => {
    await subscribe(env.DB, 101);
    await subscribe(env.DB, 202);
    const { telegramMessages } = mockServices({
      steamResponses: [steamHtml([MOONLIGHTER])],
      telegramResponse(payload) {
        if (payload.chat_id === 101) {
          return telegramError(403, "Forbidden: bot was blocked");
        }
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 2 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(checkGiveaways(env, 1_786_342_400)).resolves.toBeUndefined();

    expect(telegramMessages.map(({ chat_id: chatId }) => chatId)).toEqual([
      101, 202,
    ]);
    expect(
      await env.DB.prepare(
        "SELECT GROUP_CONCAT(chat_id) AS ids FROM subscribers",
      ).first("ids"),
    ).toBe("202");
    expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());
  });
});
