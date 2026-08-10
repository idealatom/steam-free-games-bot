import {
  listPendingBySubscriber,
  markDelivered,
  reconcileOffers,
  unsubscribe,
} from "./repository.js";
import { fetchSteamOffers } from "./steam.js";
import {
  formatOffersMessage,
  sendTelegramMessage,
  TelegramError,
} from "./telegram.js";

function notificationHeading(offerCount) {
  return offerCount === 1
    ? "New free game on Steam:"
    : "New free games on Steam:";
}

export async function checkGiveaways(env, observedAt = Date.now()) {
  const currentOffers = await fetchSteamOffers(env.STEAM_SEARCH_URL);
  await reconcileOffers(env.DB, currentOffers, observedAt);

  const pending = await listPendingBySubscriber(env.DB);
  const failures = [];

  for (const [chatId, offers] of pending) {
    try {
      await sendTelegramMessage(
        env,
        chatId,
        formatOffersMessage(offers, notificationHeading(offers.length)),
      );
      await markDelivered(
        env.DB,
        chatId,
        offers.map(({ appId }) => appId),
        observedAt,
      );
    } catch (error) {
      if (error instanceof TelegramError && error.status === 403) {
        await unsubscribe(env.DB, chatId);
      } else {
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to notify some subscribers");
  }
}
