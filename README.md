# Steam Free Games Bot

Telegram-бот раз в час проверяет [постоянную ссылку Steam](https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1) и присылает друзьям новые платные игры, которые временно отдают со скидкой 100%.

- `/start` — подписаться и сразу получить текущие раздачи, если кеш уже заполнен;
- `/stop` — отписаться;
- завершившиеся раздачи не создают сообщений;
- если та же игра позже снова станет бесплатной, бот пришлёт её ещё раз.

Бот работает на бесплатных Cloudflare Workers и D1. Отдельный сервер не нужен. Текущая реализация рассчитана примерно на 30–40 друзей.

## Что понадобится

- бесплатный аккаунт [Cloudflare](https://dash.cloudflare.com/sign-up);
- Node.js 22 или новее и npm;
- Telegram-бот, созданный через [@BotFather](https://t.me/BotFather).

У BotFather выполните `/newbot`, задайте имя и username, затем сохраните выданный токен. Не добавляйте токен ни в файлы проекта, ни в Git.

## 1. Установка и проверка

```bash
npm install
npm test
npm run check
```

`npm run check` повторно запускает тесты и собирает Worker через Wrangler в режиме `--dry-run`. Он не обращается к настоящим Steam и Telegram.

Войдите в Cloudflare:

```bash
npx wrangler login
```

## 2. Создание D1

Создайте удалённую базу:

```bash
npx wrangler d1 create steam-free-games-bot
```

Wrangler напечатает UUID `database_id`. В [wrangler.jsonc](./wrangler.jsonc) замените значение `"local"` на этот UUID, не меняя `binding` и `database_name`.

Примените миграцию:

```bash
npx wrangler d1 migrations apply steam-free-games-bot --remote
```

Команда должна показать применение `0001_initial.sql` и запросить подтверждение записи в удалённую базу.

## 3. Секреты

Следующий блок запрашивает токен скрыто и передаёт его Wrangler через stdin, поэтому значение не окажется в shell history:

```bash
read -rsp "Telegram bot token: " TELEGRAM_BOT_TOKEN; echo
printf %s "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Создайте случайный секрет webhook. Сохраните переменную в текущем терминале: она понадобится после deploy.

```bash
TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)"
printf %s "$TELEGRAM_WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Не закрывайте этот терминал до регистрации webhook. Если переменная потерялась, придумайте новое значение и повторно выполните `wrangler secret put`.

## 4. Deploy

```bash
npx wrangler deploy
```

В конце Wrangler напечатает адрес наподобие:

```text
https://steam-free-games-bot.<ваш-subdomain>.workers.dev
```

Сохраните адрес без завершающего `/`:

```bash
read -rp "Worker URL: " WORKER_URL
```

Cron `0 * * * *` запускается в начале каждого часа по UTC. После первого успешного запуска активные раздачи сохранятся в D1.

## 5. Регистрация Telegram webhook

В том же терминале выполните:

```bash
curl -sS --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

Ожидаемый ответ содержит `"ok":true`. Проверьте регистрацию:

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

В поле `url` должен быть `${WORKER_URL}/webhook`, а `last_error_message` должен отсутствовать или быть пустым.

Удалите секреты из переменных текущего терминала:

```bash
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET WORKER_URL
```

## 6. Проверка в Telegram

1. Откройте `https://t.me/<username вашего бота>`.
2. Нажмите Start или отправьте `/start`.
3. Бот сразу подтвердит подписку.
4. Если первый часовой Steam-check уже прошёл и раздачи есть, бот сразу покажет их. Иначе он пришлёт их при ближайшем успешном запуске cron.
5. Отправьте `/stop` и убедитесь, что бот подтвердил отключение уведомлений.

Каждый друг самостоятельно выполняет `/start`. Администраторские подтверждения и ручное добавление chat ID не нужны.

## Локальная проверка cron

Она использует отдельную локальную D1 и не меняет production:

```bash
npx wrangler d1 migrations apply steam-free-games-bot --local
npx wrangler dev --test-scheduled
```

Во втором терминале:

```bash
curl -sS "http://localhost:8787/cdn-cgi/handler/scheduled"
```

Для полноценной локальной отправки создайте игнорируемый Git-файл `.dev.vars` с тестовым Telegram-ботом. Не копируйте production-токен в репозиторий.

## Диагностика

Посмотреть runtime-ошибки без сохранения Telegram updates и chat ID:

```bash
npx wrangler tail
```

Если `/start` не отвечает:

- проверьте `getWebhookInfo` и последние ошибки Telegram;
- убедитесь, что URL заканчивается на `/webhook`;
- повторно задайте одинаковый `TELEGRAM_WEBHOOK_SECRET` в Cloudflare и `setWebhook`;
- проверьте, что удалённая миграция D1 применена.

Если подписка работает, но игр нет:

- дождитесь начала следующего часа UTC;
- откройте исходную ссылку Steam и проверьте, есть ли раздачи со скидкой именно 100%;
- посмотрите исключения cron через Cloudflare Workers Logs или `wrangler tail`.

Если пользователь заблокировал бота, Telegram отвечает `403`, и его подписка автоматически удаляется. Временные ошибки Telegram остаются недоставленными и повторяются на следующем часовом запуске только для затронутого пользователя.

Если deploy сообщает о неверном D1 ID, значение `"local"` в `wrangler.jsonc` не было заменено UUID из `wrangler d1 create`.

## Обновление и откат

Перед обновлением:

```bash
npm ci
npm run check
npx wrangler deploy
```

Для отката разверните проверенный предыдущий Git-коммит:

```bash
git switch --detach <commit>
npm ci
npx wrangler deploy
git switch -
```

Миграция этой версии только создаёт таблицы. Удалять D1 или откатывать схему при откате Worker не требуется.
