function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatOffersMessage(offers, heading) {
  if (offers.length === 0) {
    throw new Error("Cannot format an empty offer list");
  }

  const links = offers.map(
    ({ appId, title }) =>
      `• <a href="https://store.steampowered.com/app/${appId}/">${escapeHtml(title)}</a>`,
  );
  return `<b>${escapeHtml(heading)}</b>\n\n${links.join("\n")}`;
}

export class TelegramError extends Error {
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function requestTelegram(env, chatId, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
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

export async function sendTelegramMessage(env, chatId, text) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestTelegram(env, chatId, text);
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
