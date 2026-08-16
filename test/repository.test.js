import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { listOffers, reconcileOffers } from "../src/repository.js";
import { BREATHEDGE, MOONLIGHTER } from "./fixtures.js";

const NOW = 1_786_342_400_000;

describe("giveaway repository", () => {
  it("inserts, updates, removes, and returns offers in app id order", async () => {
    await reconcileOffers(env.DB, [BREATHEDGE, MOONLIGHTER], NOW);
    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER, BREATHEDGE]);

    await reconcileOffers(
      env.DB,
      [{ ...BREATHEDGE, title: "Breathedge updated" }],
      NOW + 1_000,
    );

    expect(await listOffers(env.DB)).toEqual([
      { ...BREATHEDGE, title: "Breathedge updated" },
    ]);
    expect(
      await env.DB.prepare("SELECT observed_at FROM offers").first("observed_at"),
    ).toBe(NOW + 1_000);
  });

  it("accepts an empty offer set and leaves an unchanged row untouched", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], NOW);
    await reconcileOffers(env.DB, [MOONLIGHTER], NOW + 1_000);

    expect(
      await env.DB.prepare("SELECT observed_at FROM offers").first("observed_at"),
    ).toBe(NOW);

    await reconcileOffers(env.DB, [], NOW + 2_000);
    expect(await listOffers(env.DB)).toEqual([]);
  });
});
