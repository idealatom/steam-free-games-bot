import { checkGiveaways } from "./check-giveaways.js";
import { consumeNotifications } from "./notification-queue.js";
import { handleTelegramUpdate } from "./subscriptions.js";

const WEBHOOK_PATH = "/webhook";

function response(status, headers) {
  return new Response(null, { status, headers });
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== WEBHOOK_PATH) {
      return response(404);
    }

    if (request.method !== "POST") {
      return response(405, { Allow: "POST" });
    }

    const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
    if (
      typeof webhookSecret !== "string" ||
      webhookSecret.length === 0 ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== webhookSecret
    ) {
      return response(401);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return response(400);
    }

    await handleTelegramUpdate(env, update);
    return response(204);
  },

  async scheduled(controller, env) {
    await checkGiveaways(env, controller.scheduledTime);
  },

  async queue(batch, env) {
    await consumeNotifications(batch, env);
  },
};
