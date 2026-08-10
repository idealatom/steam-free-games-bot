import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeNotifications } from "../src/notification-queue.js";
import { subscribe, unsubscribe } from "../src/repository.js";
import { MOONLIGHTER } from "./fixtures.js";

const NOW = 1_786_342_400_000;

function telegramResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(eventId, chatId) {
  return {
    body: { eventId, chatId },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function createEvent(offers = [MOONLIGHTER]) {
  return env.DB.prepare(
    `INSERT INTO notification_events (offers_json, created_at, dispatched_at)
     VALUES (?, ?, ?) RETURNING id`,
  )
    .bind(JSON.stringify(offers), NOW, NOW)
    .first("id");
}

describe("notification Queue consumer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a batch sequentially, stores deliveries, and acknowledges successes", async () => {
    const eventId = await createEvent();
    const messages = [];
    for (let chatId = 1; chatId <= 10; chatId += 1) {
      await subscribe(env.DB, chatId, NOW - 1);
      messages.push(message(eventId, chatId));
    }
    let activeRequests = 0;
    let maxActiveRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        return telegramResponse({ ok: true, result: { message_id: 1 } });
      }),
    );

    await consumeNotifications({ messages }, env);

    expect(maxActiveRequests).toBe(1);
    expect(messages.every(({ ack }) => ack.mock.calls.length === 1)).toBe(true);
    expect(messages.every(({ retry }) => retry.mock.calls.length === 0)).toBe(
      true,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_deliveries",
      ).first("count"),
    ).toBe(10);
  });

  it("acknowledges already delivered and unsubscribed jobs without Telegram", async () => {
    const eventId = await createEvent();
    await subscribe(env.DB, 101, NOW - 1);
    await env.DB.prepare(
      `INSERT INTO notification_deliveries (event_id, chat_id, delivered_at)
       VALUES (?, ?, ?)`,
    )
      .bind(eventId, 101, NOW)
      .run();
    const delivered = message(eventId, 101);
    const unsubscribed = message(eventId, 202);
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    await consumeNotifications({ messages: [delivered, unsubscribed] }, env);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(unsubscribed.ack).toHaveBeenCalledOnce();
  });

  it("skips a stale job after the chat stops and subscribes again", async () => {
    const eventId = await createEvent();
    await subscribe(env.DB, 101, NOW - 1);
    const queued = message(eventId, 101);
    await unsubscribe(env.DB, 101);
    await subscribe(env.DB, 101, NOW + 1);
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    await consumeNotifications({ messages: [queued] }, env);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("acknowledges successful jobs and retries only transient failures", async () => {
    const eventId = await createEvent();
    await subscribe(env.DB, 101, NOW - 1);
    await subscribe(env.DB, 202, NOW - 1);
    const success = message(eventId, 101);
    const failure = message(eventId, 202);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        const { chat_id: chatId } = JSON.parse(options.body);
        return chatId === 101
          ? telegramResponse({ ok: true, result: { message_id: 1 } })
          : telegramResponse(
              { ok: false, error_code: 500, description: "Internal error" },
              500,
            );
      }),
    );

    await consumeNotifications({ messages: [success, failure] }, env);

    expect(success.ack).toHaveBeenCalledOnce();
    expect(success.retry).not.toHaveBeenCalled();
    expect(failure.ack).not.toHaveBeenCalled();
    expect(failure.retry).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT GROUP_CONCAT(chat_id) AS ids FROM notification_deliveries",
      ).first("ids"),
    ).toBe("101");
  });

  it("uses Telegram retry_after as the Queue retry delay", async () => {
    const eventId = await createEvent();
    await subscribe(env.DB, 101, NOW - 1);
    const queued = message(eventId, 101);
    const fetchStub = vi.fn(async () =>
      telegramResponse(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 7 },
        },
        429,
      ),
    );
    vi.stubGlobal("fetch", fetchStub);

    await consumeNotifications({ messages: [queued] }, env);

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 7 });
    expect(queued.ack).not.toHaveBeenCalled();
  });

  it("removes and acknowledges a subscriber who blocked the bot", async () => {
    const eventId = await createEvent();
    await subscribe(env.DB, 101, NOW - 1);
    const queued = message(eventId, 101);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        telegramResponse(
          { ok: false, error_code: 403, description: "Forbidden" },
          403,
        ),
      ),
    );

    await consumeNotifications({ messages: [queued] }, env);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM subscribers",
      ).first("count"),
    ).toBe(0);
  });

  it("retries a Telegram success if recording its delivery fails", async () => {
    const eventId = await createEvent();
    await subscribe(env.DB, 101, NOW - 1);
    const queued = message(eventId, 101);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        telegramResponse({ ok: true, result: { message_id: 1 } }),
      ),
    );
    const failingDb = {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO notification_deliveries")) {
          return {
            bind() {
              return { run: async () => { throw new Error("D1 unavailable"); } };
            },
          };
        }
        return env.DB.prepare(sql);
      },
    };

    await consumeNotifications(
      { messages: [queued] },
      { ...env, DB: failingDb },
    );

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
  });
});
