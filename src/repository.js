const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function toOffer(row) {
  return {
    appId: Number(row.app_id),
    title: row.title,
    url: row.url,
  };
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function deliveryKey(eventId, chatId) {
  return `${eventId}:${chatId}`;
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
    .prepare("SELECT app_id, title, url FROM offers")
    .all();
  const existing = new Map(
    existingRows.map((row) => [Number(row.app_id), row]),
  );
  const currentIds = new Set(offers.map(({ appId }) => appId));
  const added = offers.filter(({ appId }) => !existing.has(appId));
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

  if (added.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO notification_events (offers_json, created_at)
           VALUES (?, ?) RETURNING id`,
        )
        .bind(JSON.stringify(added), observedAt),
    );
  }

  if (statements.length === 0) {
    return null;
  }

  const results = await db.batch(statements);
  if (added.length === 0) {
    return null;
  }
  return Number(results.at(-1).results[0].id);
}

export async function listDispatchableEvents(db, now = Date.now()) {
  const { results: eventRows } = await db
    .prepare(
      `SELECT id
       FROM notification_events
       WHERE created_at >= ?
         AND (dispatched_at IS NULL OR dispatched_at <= ?)
       ORDER BY id`,
    )
    .bind(now - DAY, now - HOUR)
    .all();
  if (eventRows.length === 0) {
    return [];
  }

  const eventIds = eventRows.map(({ id }) => Number(id));
  const { results: jobRows } = await db
    .prepare(
      `SELECT e.id AS event_id, s.chat_id
       FROM notification_events AS e
       JOIN subscribers AS s ON s.subscribed_at <= e.created_at
       LEFT JOIN notification_deliveries AS d
         ON d.event_id = e.id AND d.chat_id = s.chat_id
       WHERE e.id IN (${placeholders(eventIds)})
         AND d.event_id IS NULL
       ORDER BY e.id, s.chat_id`,
    )
    .bind(...eventIds)
    .all();
  const events = new Map(eventIds.map((id) => [id, { id, jobs: [] }]));

  for (const row of jobRows) {
    const eventId = Number(row.event_id);
    events.get(eventId).jobs.push({
      eventId,
      chatId: Number(row.chat_id),
    });
  }
  return [...events.values()];
}

export async function markEventDispatched(db, eventId, dispatchedAt = Date.now()) {
  await db
    .prepare("UPDATE notification_events SET dispatched_at = ? WHERE id = ?")
    .bind(dispatchedAt, eventId)
    .run();
}

export async function loadNotificationState(db, jobs) {
  const eventIds = [...new Set(jobs.map(({ eventId }) => eventId))];
  const chatIds = [...new Set(jobs.map(({ chatId }) => chatId))];
  const [eventResult, subscriberResult, deliveryResult] = await Promise.all([
    db
      .prepare(
        `SELECT id, offers_json, created_at FROM notification_events
         WHERE id IN (${placeholders(eventIds)})`,
      )
      .bind(...eventIds)
      .all(),
    db
      .prepare(
        `SELECT chat_id, subscribed_at FROM subscribers
         WHERE chat_id IN (${placeholders(chatIds)})`,
      )
      .bind(...chatIds)
      .all(),
    db
      .prepare(
        `SELECT event_id, chat_id FROM notification_deliveries
         WHERE event_id IN (${placeholders(eventIds)})
           AND chat_id IN (${placeholders(chatIds)})`,
      )
      .bind(...eventIds, ...chatIds)
      .all(),
  ]);

  return {
    events: new Map(
      eventResult.results.map(
        ({ id, offers_json: offersJson, created_at: createdAt }) => [
          Number(id),
          { offers: JSON.parse(offersJson), createdAt: Number(createdAt) },
        ],
      ),
    ),
    subscribers: new Map(
      subscriberResult.results.map(
        ({ chat_id: chatId, subscribed_at: subscribedAt }) => [
          Number(chatId),
          Number(subscribedAt),
        ],
      ),
    ),
    deliveries: new Set(
      deliveryResult.results.map(({ event_id: eventId, chat_id: chatId }) =>
        deliveryKey(Number(eventId), Number(chatId)),
      ),
    ),
  };
}

export async function recordNotificationDeliveries(
  db,
  jobs,
  deliveredAt = Date.now(),
) {
  if (jobs.length === 0) {
    return;
  }
  const values = jobs.map(() => "(?, ?, ?)").join(", ");
  await db
    .prepare(
      `INSERT INTO notification_deliveries (event_id, chat_id, delivered_at)
       VALUES ${values}
       ON CONFLICT (event_id, chat_id) DO NOTHING`,
    )
    .bind(...jobs.flatMap(({ eventId, chatId }) => [eventId, chatId, deliveredAt]))
    .run();
}

export async function cleanupNotificationEvents(db, now = Date.now()) {
  await db
    .prepare("DELETE FROM notification_events WHERE created_at < ?")
    .bind(now - 30 * DAY)
    .run();
}

export { deliveryKey };
