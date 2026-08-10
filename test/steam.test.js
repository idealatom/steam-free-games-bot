import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSteamOffers, parseSteamOffers } from "../src/steam.js";
import {
  BREATHEDGE,
  MOONLIGHTER,
  STEAM_RESULTS_HTML,
  STEAM_SEARCH_URL,
} from "./fixtures.js";

describe("Steam search results", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only explicit 100 percent Steam game discounts", async () => {
    expect(await parseSteamOffers(STEAM_RESULTS_HTML)).toEqual([
      MOONLIGHTER,
      BREATHEDGE,
    ]);
  });

  it("decodes HTML text and constructs a canonical URL", async () => {
    const html = `
      <div id="search_resultsRows">
        <a class="search_result_row" data-ds-appid="7" href="https://example.test/wrong">
          <span class="title">A &amp; B</span>
          <div class="discount_pct">-100%</div>
        </a>
      </div>`;

    expect(await parseSteamOffers(html)).toEqual([
      {
        appId: 7,
        title: "A & B",
        url: "https://store.steampowered.com/app/7/",
      },
    ]);
  });

  it("accepts a recognizable empty result", async () => {
    await expect(
      parseSteamOffers('<div id="search_results" class="search_results"></div>'),
    ).resolves.toEqual([]);
  });

  it("rejects an unrecognized response instead of treating it as empty", async () => {
    await expect(parseSteamOffers("<html>Access denied</html>")).rejects.toThrow(
      "Steam response is not a search result",
    );
  });

  it("fetches compact Steam results with the supplied filters", async () => {
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: 1,
          results_html: STEAM_RESULTS_HTML,
          total_count: 2,
        }),
        {
        status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchStub);

    await expect(fetchSteamOffers(STEAM_SEARCH_URL)).resolves.toEqual([
      MOONLIGHTER,
      BREATHEDGE,
    ]);
    expect(fetchStub).toHaveBeenCalledOnce();
    const [requestedUrl, options] = fetchStub.mock.calls[0];
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/search/results/");
    expect(url.searchParams.get("maxprice")).toBe("free");
    expect(url.searchParams.get("category1")).toBe("998");
    expect(url.searchParams.get("specials")).toBe("1");
    expect(url.searchParams.get("count")).toBe("50");
    expect(url.searchParams.get("infinite")).toBe("1");
    expect(options.headers["user-agent"]).toMatch(/Mozilla/);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a successful JSON response whose rows cannot be parsed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: 1,
            results_html: "<div>new unknown markup</div>",
            total_count: 1,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(fetchSteamOffers(STEAM_SEARCH_URL)).rejects.toThrow(
      "Steam result rows do not match the reported count",
    );
  });

  it("rejects a non-successful Steam response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(fetchSteamOffers(STEAM_SEARCH_URL)).rejects.toThrow(
      "Steam request failed with HTTP 503",
    );
  });
});
