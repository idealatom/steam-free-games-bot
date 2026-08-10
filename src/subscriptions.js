import {
  listOffers,
  markDelivered,
  subscribe,
  unsubscribe,
} from "./repository.js";
import { formatOffersMessage, sendTelegramMessage } from "./telegram.js";

const SUBSCRIBED_MESSAGE =
  "✅ Вы подписались на уведомления о бесплатных играх Steam.";
const UNSUBSCRIBED_MESSAGE = "🔕 Уведомления отключены.";
const HELP_MESSAGE =
  "Доступные команды:\n/start — подписаться\n/stop — отписаться";

function getCommand(text) {
  return text.trim().split(/\s+/, 1)[0].toLowerCase().split("@", 1)[0];
}

export async function handleTelegramUpdate(env, update) {
  const message = update?.message;
  if (
    message?.chat?.type !== "private" ||
    !Number.isSafeInteger(message.chat.id) ||
    typeof message.text !== "string"
  ) {
    return;
  }

  const chatId = message.chat.id;
  const command = getCommand(message.text);

  if (command === "/start") {
    await subscribe(env.DB, chatId);
    await sendTelegramMessage(env, chatId, SUBSCRIBED_MESSAGE);
    const offers = await listOffers(env.DB);
    if (offers.length > 0) {
      await sendTelegramMessage(
        env,
        chatId,
        formatOffersMessage(offers, "Сейчас бесплатно в Steam:"),
      );
      await markDelivered(
        env.DB,
        chatId,
        offers.map(({ appId }) => appId),
      );
    }
    return;
  }

  if (command === "/stop") {
    await unsubscribe(env.DB, chatId);
    await sendTelegramMessage(env, chatId, UNSUBSCRIBED_MESSAGE);
    return;
  }

  await sendTelegramMessage(env, chatId, HELP_MESSAGE);
}
