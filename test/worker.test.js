import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import { MOONLIGHTER, privateCommand } from "./fixtures.js";

function webhookRequest(body, { method = "POST", secret } = {}) {
  const headers = {};
  if (secret !== undefined) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  }
  return new Request("https://worker.example/webhook", {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  });
}

function successfulTelegramResponse() {
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Worker entry points", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects non-POST webhook requests", async () => {
    const response = await SELF.fetch(
      webhookRequest(undefined, { method: "GET" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("returns not found outside the webhook path", async () => {
    const response = await SELF.fetch("https://worker.example/");

    expect(response.status).toBe(404);
  });

  it.each([undefined, "wrong-secret"])(
    "rejects a missing or wrong webhook secret without side effects",
    async (secret) => {
      const fetchStub = vi.fn();
      vi.stubGlobal("fetch", fetchStub);

      const response = await SELF.fetch(
        webhookRequest(JSON.stringify(privateCommand(101, "/start")), {
          secret,
        }),
      );

      expect(response.status).toBe(401);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM subscribers").first(
          "count",
        ),
      ).toBe(0);
    },
  );

  it("rejects invalid JSON without side effects", async () => {
    const response = await SELF.fetch(
      webhookRequest("not-json", { secret: env.TELEGRAM_WEBHOOK_SECRET }),
    );

    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM subscribers").first(
        "count",
      ),
    ).toBe(0);
  });

  it("processes an authenticated start command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => successfulTelegramResponse()));

    const response = await SELF.fetch(
      webhookRequest(JSON.stringify(privateCommand(101, "/start")), {
        secret: env.TELEGRAM_WEBHOOK_SECRET,
      }),
    );

    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT chat_id FROM subscribers").first("chat_id"),
    ).toBe(101);
  });

  it("acknowledges an unsupported update without side effects", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const response = await SELF.fetch(
      webhookRequest(JSON.stringify({ update_id: 1, edited_message: {} }), {
        secret: env.TELEGRAM_WEBHOOK_SECRET,
      }),
    );

    expect(response.status).toBe(204);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("uses the scheduled time to store and queue an hourly offer", async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (chat_id, subscribed_at) VALUES (?, ?)",
    )
      .bind(101, 1_786_342_399_000)
      .run();
    const batches = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        if (new URL(url).pathname === "/search/results/") {
          return new Response(JSON.stringify({
            success: 1,
            total_count: 1,
            results_html: `
              <a class="search_result_row" data-ds-appid="${MOONLIGHTER.appId}">
                <span class="title">${MOONLIGHTER.title}</span>
                <div class="discount_pct">-100%</div>
              </a>
            `,
          }));
        }
        throw new Error(`Unexpected direct request: ${url}`);
      }),
    );

    await worker.scheduled(
      { scheduledTime: 1_786_342_400_000, cron: "0 * * * *" },
      {
        DB: env.DB,
        STEAM_SEARCH_URL: env.STEAM_SEARCH_URL,
        NOTIFICATION_QUEUE: {
          async sendBatch(messages) {
            batches.push(messages);
          },
        },
      },
      {},
    );

    expect(
      await env.DB.prepare("SELECT observed_at FROM offers").first("observed_at"),
    ).toBe(1_786_342_400_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].body.chatId).toBe(101);
  });

  it("delegates Queue batches to the notification consumer", async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (chat_id, subscribed_at) VALUES (?, ?)",
    )
      .bind(101, 1_786_342_399_000)
      .run();
    const eventId = await env.DB.prepare(
      `INSERT INTO notification_events (offers_json, created_at, dispatched_at)
       VALUES (?, ?, ?) RETURNING id`,
    )
      .bind(JSON.stringify([MOONLIGHTER]), 1_786_342_400_000, 1_786_342_400_000)
      .first("id");
    vi.stubGlobal("fetch", vi.fn(async () => successfulTelegramResponse()));
    const message = {
      body: { eventId, chatId: 101 },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await worker.queue({ messages: [message] }, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
