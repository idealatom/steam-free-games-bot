function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function storeUrl(appId) {
  return `https://store.steampowered.com/app/${appId}/`;
}

function offerLink({ appId, title }) {
  const characters = [...title];
  const displayTitle =
    characters.length > 60
      ? `${characters.slice(0, 59).join("")}…`
      : title;
  return `<a href="${storeUrl(appId)}">${escapeHtml(displayTitle)}</a>`;
}

export function formatOfferCaption(offer) {
  return `<b>New free Steam game:</b>\n\n🎁 ${offerLink(offer)}`;
}

export class TelegramError extends Error {
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function sendTelegramRequestOnce(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok && body?.ok === true) {
    return body.result;
  }

  const status = body?.error_code ?? response.status;
  const retryAfter = body?.parameters?.retry_after;
  throw new TelegramError(
    body?.description ?? `Telegram request failed with HTTP ${response.status}`,
    { status, retryAfter },
  );
}

async function sendTelegramRequest(env, method, payload) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await sendTelegramRequestOnce(env, method, payload);
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof TelegramError &&
        error.status === 429 &&
        Number.isFinite(error.retryAfter) &&
        error.retryAfter > 0
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, error.retryAfter * 1_000),
        );
        continue;
      }
      throw error;
    }
  }
}

export function sendTelegramOffer(env, chatId, offer) {
  return sendTelegramRequest(env, "sendPhoto", {
    chat_id: chatId,
    photo: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${offer.appId}/header.jpg`,
    caption: formatOfferCaption(offer),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎮 Open in Steam", url: storeUrl(offer.appId) }],
      ],
    },
  });
}

export function sendTelegramOfferList(env, chatId, offers) {
  return sendTelegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text: `<b>New free Steam games:</b>\n\n${offers
      .map((offer) => `🎁 ${offerLink(offer)}`)
      .join("\n")}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}
