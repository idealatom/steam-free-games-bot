import {
  cleanupNotificationEvents,
  listDispatchableEvents,
  markEventDispatched,
  reconcileOffers,
} from "./repository.js";
import { fetchSteamOffers } from "./steam.js";

const QUEUE_BATCH_SIZE = 100;

async function dispatchPendingEvents(env, dispatchedAt) {
  const events = await listDispatchableEvents(env.DB, dispatchedAt);
  for (const event of events) {
    for (let offset = 0; offset < event.jobs.length; offset += QUEUE_BATCH_SIZE) {
      await env.NOTIFICATION_QUEUE.sendBatch(
        event.jobs
          .slice(offset, offset + QUEUE_BATCH_SIZE)
          .map((body) => ({ body })),
      );
    }
    await markEventDispatched(env.DB, event.id, dispatchedAt);
  }
}

export async function checkGiveaways(env, observedAt = Date.now()) {
  try {
    const currentOffers = await fetchSteamOffers(env.STEAM_SEARCH_URL);
    await reconcileOffers(env.DB, currentOffers, observedAt);
  } finally {
    await dispatchPendingEvents(env, observedAt);
  }

  if (new Date(observedAt).getUTCHours() === 0) {
    await cleanupNotificationEvents(env.DB, observedAt);
  }
}
