function toOffer(row) {
  return {
    appId: Number(row.app_id),
    title: row.title,
    url: row.url,
  };
}

export async function listOffers(db) {
  const { results } = await db
    .prepare("SELECT app_id, title, url FROM offers ORDER BY app_id")
    .all();
  return results.map(toOffer);
}

export async function reconcileOffers(db, offers, observedAt = Date.now()) {
  const { results: existingRows } = await db
    .prepare("SELECT app_id, title, url FROM offers")
    .all();
  const existing = new Map(
    existingRows.map((row) => [Number(row.app_id), row]),
  );
  const currentIds = new Set(offers.map(({ appId }) => appId));
  const statements = existingRows
    .filter(({ app_id: appId }) => !currentIds.has(Number(appId)))
    .map(({ app_id: appId }) =>
      db.prepare("DELETE FROM offers WHERE app_id = ?").bind(appId),
    );

  for (const offer of offers) {
    const previous = existing.get(offer.appId);
    if (
      previous &&
      previous.title === offer.title &&
      previous.url === offer.url
    ) {
      continue;
    }
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
