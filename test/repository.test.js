import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  listDispatchableEvents,
  listOffers,
  markEventDispatched,
  reconcileOffers,
  recordNotificationDeliveries,
  subscribe,
  unsubscribe,
} from "../src/repository.js";
import { BREATHEDGE, MOONLIGHTER } from "./fixtures.js";

const NOW = 1_786_342_400_000;

describe("giveaway repository", () => {
  it("keeps the original subscription time when start is repeated", async () => {
    await subscribe(env.DB, 101, NOW - 1_000);
    await subscribe(env.DB, 101, NOW);

    expect(
      await env.DB.prepare(
        "SELECT chat_id, subscribed_at FROM subscribers",
      ).first(),
    ).toEqual({ chat_id: 101, subscribed_at: NOW - 1_000 });
  });

  it("creates one immutable event containing only newly added offers", async () => {
    const firstEventId = await reconcileOffers(
      env.DB,
      [MOONLIGHTER],
      NOW,
    );
    const unchangedEventId = await reconcileOffers(
      env.DB,
      [{ ...MOONLIGHTER, title: "Moonlighter updated" }],
      NOW + 1_000,
    );
    const secondEventId = await reconcileOffers(
      env.DB,
      [{ ...MOONLIGHTER, title: "Moonlighter updated" }, BREATHEDGE],
      NOW + 2_000,
    );

    expect(firstEventId).toBeTypeOf("number");
    expect(unchangedEventId).toBeNull();
    expect(secondEventId).toBeGreaterThan(firstEventId);
    expect(await listOffers(env.DB)).toEqual([
      { ...MOONLIGHTER, title: "Moonlighter updated" },
      BREATHEDGE,
    ]);

    const { results } = await env.DB.prepare(
      "SELECT offers_json FROM notification_events ORDER BY id",
    ).all();
    expect(results.map(({ offers_json: json }) => JSON.parse(json))).toEqual([
      [MOONLIGHTER],
      [BREATHEDGE],
    ]);
  });

  it("does not create an event for removal but creates one when an offer returns", async () => {
    await reconcileOffers(env.DB, [MOONLIGHTER], NOW);
    expect(await reconcileOffers(env.DB, [], NOW + 1_000)).toBeNull();
    expect(
      await reconcileOffers(env.DB, [MOONLIGHTER], NOW + 2_000),
    ).toBeTypeOf("number");

    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_events",
      ).first("count"),
    ).toBe(2);
  });

  it("lists only eligible subscribers with missing event deliveries", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    await subscribe(env.DB, 202, NOW + 1);
    const eventId = await reconcileOffers(env.DB, [MOONLIGHTER], NOW);

    expect(await listDispatchableEvents(env.DB, NOW)).toEqual([
      { id: eventId, jobs: [{ eventId, chatId: 101 }] },
    ]);

    await recordNotificationDeliveries(
      env.DB,
      [{ eventId, chatId: 101 }],
      NOW + 100,
    );
    await markEventDispatched(env.DB, eventId, NOW);

    expect(
      await listDispatchableEvents(env.DB, NOW + 60 * 60 * 1_000),
    ).toEqual([{ id: eventId, jobs: [] }]);
  });

  it("deletes a subscriber and their old and event deliveries", async () => {
    await subscribe(env.DB, 101, NOW - 1);
    const eventId = await reconcileOffers(env.DB, [MOONLIGHTER], NOW);
    await env.DB.prepare(
      "INSERT INTO deliveries (chat_id, app_id, delivered_at) VALUES (?, ?, ?)",
    )
      .bind(101, MOONLIGHTER.appId, NOW)
      .run();
    await recordNotificationDeliveries(
      env.DB,
      [{ eventId, chatId: 101 }],
      NOW,
    );

    await unsubscribe(env.DB, 101);

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries").first(
        "count",
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_deliveries",
      ).first("count"),
    ).toBe(0);
  });
});
