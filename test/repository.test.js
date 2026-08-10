import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  listOffers,
  listPendingBySubscriber,
  markDelivered,
  reconcileOffers,
  subscribe,
  unsubscribe,
} from "../src/repository.js";

const MOONLIGHTER = {
  appId: 606150,
  title: "Moonlighter",
  url: "https://store.steampowered.com/app/606150/",
};
const BREATHEDGE = {
  appId: 738520,
  title: "Breathedge",
  url: "https://store.steampowered.com/app/738520/",
};

describe("giveaway repository", () => {
  it("keeps one subscriber when subscription is repeated", async () => {
    await subscribe(env.DB, 101, 1_786_342_400);
    await subscribe(env.DB, 101, 1_786_346_000);

    const row = await env.DB.prepare(
      "SELECT chat_id, subscribed_at FROM subscribers",
    ).first();

    expect(row).toEqual({ chat_id: 101, subscribed_at: 1_786_342_400 });
  });

  it("lists each undelivered offer under each subscriber", async () => {
    await subscribe(env.DB, 101);
    await subscribe(env.DB, 202);
    await reconcileOffers(env.DB, [BREATHEDGE, MOONLIGHTER], 1_786_342_400);

    const pending = await listPendingBySubscriber(env.DB);

    expect([...pending]).toEqual([
      [101, [MOONLIGHTER, BREATHEDGE]],
      [202, [MOONLIGHTER, BREATHEDGE]],
    ]);
  });

  it("keeps deliveries for unchanged offers and removes them with ended offers", async () => {
    await subscribe(env.DB, 101);
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    await markDelivered(env.DB, 101, [MOONLIGHTER.appId], 1_786_342_401);
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_346_000);
    expect(await listPendingBySubscriber(env.DB)).toEqual(new Map());

    await reconcileOffers(env.DB, [], 1_786_349_600);
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_353_200);
    expect([...await listPendingBySubscriber(env.DB)]).toEqual([
      [101, [MOONLIGHTER]],
    ]);
  });

  it("deletes a subscriber and their deliveries", async () => {
    await subscribe(env.DB, 101);
    await reconcileOffers(env.DB, [MOONLIGHTER], 1_786_342_400);
    await markDelivered(env.DB, 101, [MOONLIGHTER.appId]);

    await unsubscribe(env.DB, 101);

    expect(await env.DB.prepare("SELECT * FROM subscribers").all()).toMatchObject({
      results: [],
    });
    expect(await env.DB.prepare("SELECT * FROM deliveries").all()).toMatchObject({
      results: [],
    });
  });

  it("lists offers in stable app ID order and ignores an empty delivery batch", async () => {
    await subscribe(env.DB, 101);
    await reconcileOffers(env.DB, [BREATHEDGE, MOONLIGHTER], 1_786_342_400);

    await markDelivered(env.DB, 101, []);

    expect(await listOffers(env.DB)).toEqual([MOONLIGHTER, BREATHEDGE]);
    expect([...await listPendingBySubscriber(env.DB)]).toEqual([
      [101, [MOONLIGHTER, BREATHEDGE]],
    ]);
  });
});
