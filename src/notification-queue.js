import {
  deliveryKey,
  loadNotificationState,
  recordNotificationDeliveries,
  unsubscribe,
} from "./repository.js";
import {
  formatOffersMessage,
  sendTelegramMessageOnce,
  TelegramError,
} from "./telegram.js";

function heading(offerCount) {
  return offerCount === 1
    ? "New free game on Steam:"
    : "New free games on Steam:";
}

export async function consumeNotifications(batch, env) {
  const jobs = [];
  for (const message of batch.messages) {
    const { eventId, chatId } = message.body ?? {};
    if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(chatId)) {
      message.ack();
      continue;
    }
    jobs.push({ eventId, chatId, message });
  }
  if (jobs.length === 0) {
    return;
  }

  const state = await loadNotificationState(env.DB, jobs);
  const successful = [];

  for (const job of jobs) {
    const event = state.events.get(job.eventId);
    const subscribedAt = state.subscribers.get(job.chatId);
    if (
      !event ||
      subscribedAt === undefined ||
      subscribedAt > event.createdAt ||
      state.deliveries.has(deliveryKey(job.eventId, job.chatId))
    ) {
      job.message.ack();
      continue;
    }

    try {
      await sendTelegramMessageOnce(
        env,
        job.chatId,
        formatOffersMessage(event.offers, heading(event.offers.length)),
      );
      successful.push(job);
    } catch (error) {
      if (error instanceof TelegramError && error.status === 403) {
        try {
          await unsubscribe(env.DB, job.chatId);
          state.subscribers.delete(job.chatId);
          job.message.ack();
        } catch {
          job.message.retry();
        }
      } else if (
        error instanceof TelegramError &&
        error.status === 429 &&
        Number.isFinite(error.retryAfter) &&
        error.retryAfter > 0
      ) {
        job.message.retry({ delaySeconds: error.retryAfter });
      } else {
        job.message.retry();
      }
    }
  }

  if (successful.length === 0) {
    return;
  }
  try {
    await recordNotificationDeliveries(env.DB, successful);
    for (const { message } of successful) {
      message.ack();
    }
  } catch {
    for (const { message } of successful) {
      message.retry();
    }
  }
}
