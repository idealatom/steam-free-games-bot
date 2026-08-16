import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatOfferMessage,
  sendTelegramMessage,
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

describe("Telegram messages", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("escapes titles and emits canonical Steam links", () => {
    expect(
      formatOfferMessage({
        appId: 7,
        title: "A < B & C",
        url: "https://ignored.example/",
      }),
    ).toBe(
      '<b>New free Steam game:</b>\n\n🎁 <a href="https://store.steampowered.com/app/7/">A &lt; B &amp; C</a>',
    );
  });

  it("truncates an unusually long game title", () => {
    const message = formatOfferMessage({
      ...MOONLIGHTER,
      title: "A".repeat(100),
    });

    expect(message).toContain(`${"A".repeat(59)}…</a>`);
    expect(message).not.toContain("A".repeat(60));
  });

  it("posts an HTML message with a large Steam preview above it", async () => {
    const fetchStub = vi.fn(async () =>
      telegramResponse({ ok: true, result: { message_id: 1 } }),
    );
    vi.stubGlobal("fetch", fetchStub);

    await expect(
      sendTelegramMessage(TEST_ENV, 101, "<b>Hello</b>", MOONLIGHTER.url),
    ).resolves.toEqual({ message_id: 1 });

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe(
      "https://api.telegram.org/bottest-token/sendMessage",
    );
    expect(options).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(options.body)).toEqual({
      chat_id: 101,
      text: "<b>Hello</b>",
      parse_mode: "HTML",
      link_preview_options: {
        url: MOONLIGHTER.url,
        prefer_large_media: true,
        show_above_text: true,
      },
    });
  });

  it("exposes a blocked-chat response as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        telegramResponse(
          { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
          403,
        ),
      ),
    );

    const error = await sendTelegramMessage(
      TEST_ENV,
      101,
      "message",
      MOONLIGHTER.url,
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ status: 403, retryAfter: undefined });
  });

  it("reports a non-JSON Telegram HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad gateway", { status: 502 })),
    );

    await expect(
      sendTelegramMessage(TEST_ENV, 101, "message", MOONLIGHTER.url),
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

    const delivery = sendTelegramMessage(
      TEST_ENV,
      101,
      "message",
      MOONLIGHTER.url,
    );
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

    const delivery = sendTelegramMessage(
      TEST_ENV,
      101,
      "message",
      MOONLIGHTER.url,
    );
    const assertion = expect(delivery).rejects.toMatchObject({
      status: 429,
      retryAfter: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
