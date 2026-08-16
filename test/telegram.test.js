import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatOfferCaption,
  sendTelegramOffer,
  sendTelegramOfferList,
  TelegramError,
} from "../src/telegram.js";
import { MOONLIGHTER } from "./fixtures.js";

const TEST_ENV = { TELEGRAM_BOT_TOKEN: "test-token" };

function telegramResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Telegram posts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("escapes titles and emits a canonical Steam link", () => {
    expect(
      formatOfferCaption({
        appId: 7,
        title: "A < B & C",
        url: "https://ignored.example/",
      }),
    ).toBe(
      '<b>New free Steam game:</b>\n\n🎁 <a href="https://store.steampowered.com/app/7/">A &lt; B &amp; C</a>',
    );
  });

  it("truncates an unusually long game title", () => {
    const caption = formatOfferCaption({
      ...MOONLIGHTER,
      title: "A".repeat(100),
    });

    expect(caption).toContain(`${"A".repeat(59)}…</a>`);
    expect(caption).not.toContain("A".repeat(60));
  });

  it("posts a Steam image, caption, and store button", async () => {
    const fetchStub = vi.fn(async () =>
      telegramResponse({ ok: true, result: { message_id: 1 } }),
    );
    vi.stubGlobal("fetch", fetchStub);

    await expect(
      sendTelegramOffer(TEST_ENV, 101, MOONLIGHTER),
    ).resolves.toEqual({ message_id: 1 });

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendPhoto");
    expect(options).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(options.body)).toEqual({
      chat_id: 101,
      photo:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/606150/header.jpg",
      caption:
        '<b>New free Steam game:</b>\n\n🎁 <a href="https://store.steampowered.com/app/606150/">Moonlighter</a>',
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎮 Open in Steam", url: MOONLIGHTER.url }]],
      },
    });
  });

  it("posts many games as a compact linked list without previews", async () => {
    const offers = [MOONLIGHTER, {
      appId: 7,
      title: "A < B & C",
      url: "https://store.steampowered.com/app/7/",
    }];
    const fetchStub = vi.fn(async () =>
      telegramResponse({ ok: true, result: { message_id: 2 } }),
    );
    vi.stubGlobal("fetch", fetchStub);

    await sendTelegramOfferList(TEST_ENV, 101, offers);

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(options.body)).toEqual({
      chat_id: 101,
      text:
        '<b>New free Steam games:</b>\n\n🎁 <a href="https://store.steampowered.com/app/606150/">Moonlighter</a>\n🎁 <a href="https://store.steampowered.com/app/7/">A &lt; B &amp; C</a>',
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("exposes a blocked-channel response as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        telegramResponse(
          { ok: false, error_code: 403, description: "Forbidden" },
          403,
        ),
      ),
    );

    const error = await sendTelegramOffer(TEST_ENV, 101, MOONLIGHTER).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ status: 403, retryAfter: undefined });
  });

  it("reports a non-JSON Telegram HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad gateway", { status: 502 })),
    );

    await expect(
      sendTelegramOffer(TEST_ENV, 101, MOONLIGHTER),
    ).rejects.toMatchObject({
      name: "TelegramError",
      status: 502,
      message: "Telegram request failed with HTTP 502",
    });
  });

  it("waits for retry_after and retries a rate limit exactly once", async () => {
    vi.useFakeTimers();
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        telegramResponse(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 1 },
          },
          429,
        ),
      )
      .mockResolvedValueOnce(
        telegramResponse({ ok: true, result: { message_id: 2 } }),
      );
    vi.stubGlobal("fetch", fetchStub);

    const delivery = sendTelegramOffer(TEST_ENV, 101, MOONLIGHTER);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(delivery).resolves.toEqual({ message_id: 2 });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second rate limit", async () => {
    vi.useFakeTimers();
    const rateLimit = () =>
      telegramResponse(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 1 },
        },
        429,
      );
    const fetchStub = vi
      .fn()
      .mockImplementationOnce(async () => rateLimit())
      .mockImplementationOnce(async () => rateLimit());
    vi.stubGlobal("fetch", fetchStub);

    const delivery = sendTelegramOffer(TEST_ENV, 101, MOONLIGHTER);
    const assertion = expect(delivery).rejects.toMatchObject({
      status: 429,
      retryAfter: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
