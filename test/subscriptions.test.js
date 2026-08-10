import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listPendingBySubscriber,
  markDelivered,
  reconcileOffers,
  subscribe,
} from "../src/repository.js";
import { handleTelegramUpdate } from "../src/subscriptions.js";
import { MOONLIGHTER, privateCommand } from "./fixtures.js";

function captureTelegramMessages() {
  const messages = [];
  const fetchStub = vi.fn(async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: messages.length } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return { fetchStub, messages };
}

describe("Telegram subscriptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("subscribes a private chat and immediately sends cached offers", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    const { messages } = captureTelegramMessages();

    await handleTelegramUpdate(env, privateCommand(101, "/start"));

    expect(
      await env.DB.prepare("SELECT chat_id FROM subscribers").first("chat_id"),
    ).toBe(101);
    expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain("Вы подписались");
    expect(messages[1].text).toContain("Moonlighter");
  });

  it("sends only confirmation when no cached offer exists", async () => {
    const { messages } = captureTelegramMessages();

    await handleTelegramUpdate(env, privateCommand(101, "/start"));

    expect(messages.map(({ text }) => text)).toEqual([
      "✅ Вы подписались на уведомления о бесплатных играх Steam.",
    ]);
  });

  it("keeps one subscriber and shows current offers on repeated start", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    const { messages } = captureTelegramMessages();

    await handleTelegramUpdate(env, privateCommand(101, "/start"));
    await handleTelegramUpdate(env, privateCommand(101, "/start"));

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM subscribers",
    ).first("count");
    expect(count).toBe(1);
    expect(messages).toHaveLength(4);
    expect(messages.filter(({ text }) => text.includes("Moonlighter"))).toHaveLength(
      2,
    );
  });

  it("accepts a command addressed to the bot username", async () => {
    const { messages } = captureTelegramMessages();

    await handleTelegramUpdate(
      env,
      privateCommand(101, "/start@SteamGiveawayBot hello"),
    );

    expect(messages[0].text).toContain("Вы подписались");
    expect(
      await env.DB.prepare("SELECT chat_id FROM subscribers").first("chat_id"),
    ).toBe(101);
  });

  it("stops future notifications and removes existing deliveries", async () => {
    await subscribe(env.DB, 101);
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    await markDelivered(env.DB, 101, [MOONLIGHTER.appId]);
    const { messages } = captureTelegramMessages();

    await handleTelegramUpdate(env, privateCommand(101, "/stop"));

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM subscribers").first(
        "count",
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries").first(
        "count",
      ),
    ).toBe(0);
    expect(messages.map(({ text }) => text)).toEqual([
      "🔕 Уведомления отключены.",
    ]);
  });

  it("answers unsupported private text with concise help", async () => {
    const { messages } = captureTelegramMessages();

    await handleTelegramUpdate(env, privateCommand(101, "Привет"));

    expect(messages.map(({ text }) => text)).toEqual([
      "Доступные команды:\n/start — подписаться\n/stop — отписаться",
    ]);
  });

  it("ignores group and non-text updates", async () => {
    const { fetchStub } = captureTelegramMessages();
    const groupUpdate = privateCommand(-101, "/start");
    groupUpdate.message.chat.type = "group";

    await handleTelegramUpdate(env, groupUpdate);
    await handleTelegramUpdate(env, {
      update_id: 2,
      message: { chat: { id: 101, type: "private" }, photo: [] },
    });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM subscribers").first(
        "count",
      ),
    ).toBe(0);
  });
});
