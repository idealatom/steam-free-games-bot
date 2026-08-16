import { listOffers, reconcileOffers } from "./repository.js";
import { fetchSteamOffers } from "./steam.js";
import { sendTelegramOffer, sendTelegramOfferList } from "./telegram.js";

const INDIVIDUAL_POST_LIMIT = 10;
const MAX_LIST_SIZE = 50;
const POST_INTERVAL_MS = 1_000;

export async function checkGiveaways(env, observedAt = Date.now()) {
  const currentOffers = await fetchSteamOffers(env.STEAM_SEARCH_URL);
  const previousIds = new Set(
    (await listOffers(env.DB)).map(({ appId }) => appId),
  );
  const added = currentOffers.filter(({ appId }) => !previousIds.has(appId));

  if (added.length > INDIVIDUAL_POST_LIMIT) {
    const listCount = Math.ceil(added.length / MAX_LIST_SIZE);
    const listSize = Math.ceil(added.length / listCount);
    for (let start = 0; start < added.length; start += listSize) {
      await sendTelegramOfferList(
        env,
        env.TELEGRAM_CHANNEL_ID,
        added.slice(start, start + listSize),
      );
      if (start + listSize < added.length) {
        await new Promise((resolve) => setTimeout(resolve, POST_INTERVAL_MS));
      }
    }
  } else {
    for (const [index, offer] of added.entries()) {
      await sendTelegramOffer(env, env.TELEGRAM_CHANNEL_ID, offer);
      if (index + 1 < added.length) {
        await new Promise((resolve) => setTimeout(resolve, POST_INTERVAL_MS));
      }
    }
  }

  await reconcileOffers(env.DB, currentOffers, observedAt);
}
