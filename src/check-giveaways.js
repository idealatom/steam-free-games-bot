import { listOffers, reconcileOffers } from "./repository.js";
import { fetchSteamOffers } from "./steam.js";
import { formatOfferMessage, sendTelegramMessage } from "./telegram.js";

export async function checkGiveaways(env, observedAt = Date.now()) {
  const currentOffers = await fetchSteamOffers(env.STEAM_SEARCH_URL);
  const previousIds = new Set(
    (await listOffers(env.DB)).map(({ appId }) => appId),
  );
  const added = currentOffers.filter(({ appId }) => !previousIds.has(appId));

  for (const offer of added) {
    await sendTelegramMessage(
      env,
      env.TELEGRAM_CHANNEL_ID,
      formatOfferMessage(offer),
      offer.url,
    );
  }

  await reconcileOffers(env.DB, currentOffers, observedAt);
}
