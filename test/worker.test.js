import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import { MOONLIGHTER } from "./fixtures.js";

describe("Worker entry points", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["/", "/webhook", "/anything"])("returns 404 for %s", async (path) => {
    const response = await SELF.fetch(`https://worker.example${path}`);
    expect(response.status).toBe(404);
  });

  it("uses the scheduled time and posts a new offer to the channel", async () => {
    const requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        if (new URL(url).pathname === "/search/results/") {
          return new Response(
            JSON.stringify({
              success: 1,
              total_count: 1,
              results_html: `
                <a class="search_result_row" data-ds-appid="${MOONLIGHTER.appId}">
                  <span class="title">${MOONLIGHTER.title}</span>
                  <div class="discount_pct">-100%</div>
                </a>`,
            }),
          );
        }
        requests.push(JSON.parse(options.body));
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );

    await worker.scheduled(
      { scheduledTime: 1_786_342_400_000, cron: "0 * * * *" },
      env,
      {},
    );

    expect(
      await env.DB.prepare("SELECT observed_at FROM offers").first("observed_at"),
    ).toBe(1_786_342_400_000);
    expect(requests).toHaveLength(1);
    expect(requests[0].chat_id).toBe("@test_channel");
  });
});
