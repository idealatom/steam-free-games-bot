function toOffer(row) {
  return {
    appId: Number(row.app_id),
    title: row.title,
    url: row.url,
  };
}

export async function subscribe(db, chatId, subscribedAt = Date.now()) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO subscribers (chat_id, subscribed_at) VALUES (?, ?)",
    )
    .bind(chatId, subscribedAt)
    .run();
}

export async function unsubscribe(db, chatId) {
  await db.prepare("DELETE FROM subscribers WHERE chat_id = ?").bind(chatId).run();
}

export async function listOffers(db) {
  const { results } = await db
    .prepare("SELECT app_id, title, url FROM offers ORDER BY app_id")
    .all();
  return results.map(toOffer);
}

export async function reconcileOffers(db, offers, observedAt = Date.now()) {
  const { results: existingRows } = await db
    .prepare("SELECT app_id FROM offers")
    .all();
  const currentIds = new Set(offers.map(({ appId }) => appId));
  const statements = existingRows
    .filter(({ app_id: appId }) => !currentIds.has(Number(appId)))
    .map(({ app_id: appId }) =>
      db.prepare("DELETE FROM offers WHERE app_id = ?").bind(appId),
    );

  for (const offer of offers) {
    statements.push(
      db
        .prepare(
          `INSERT INTO offers (app_id, title, url, observed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id) DO UPDATE SET
             title = excluded.title,
             url = excluded.url,
             observed_at = excluded.observed_at`,
        )
        .bind(offer.appId, offer.title, offer.url, observedAt),
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function listPendingBySubscriber(db) {
  const { results } = await db
    .prepare(
      `SELECT s.chat_id, o.app_id, o.title, o.url
       FROM subscribers AS s
       CROSS JOIN offers AS o
       LEFT JOIN deliveries AS d
         ON d.chat_id = s.chat_id AND d.app_id = o.app_id
       WHERE d.app_id IS NULL
       ORDER BY s.chat_id, o.app_id`,
    )
    .all();
  const pending = new Map();

  for (const row of results) {
    const chatId = Number(row.chat_id);
    const offers = pending.get(chatId) ?? [];
    offers.push(toOffer(row));
    pending.set(chatId, offers);
  }

  return pending;
}

export async function markDelivered(
  db,
  chatId,
  appIds,
  deliveredAt = Date.now(),
) {
  if (appIds.length === 0) {
    return;
  }

  await db.batch(
    appIds.map((appId) =>
      db
        .prepare(
          `INSERT INTO deliveries (chat_id, app_id, delivered_at)
           VALUES (?, ?, ?)
           ON CONFLICT (chat_id, app_id) DO UPDATE SET
             delivered_at = excluded.delivered_at`,
        )
        .bind(chatId, appId, deliveredAt),
    ),
  );
}
