import { checkGiveaways } from "./check-giveaways.js";

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },

  async scheduled(controller, env) {
    await checkGiveaways(env, controller.scheduledTime);
  },
};
