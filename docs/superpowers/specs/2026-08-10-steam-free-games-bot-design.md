# Steam Free Games Telegram Bot — Design

## Goal

Monitor Steam's current 100%-discounted paid games once per hour and send newly discovered games to one Telegram chat. The first successful run sends every current giveaway. The solution must use free services and require no continuously running server.

## Architecture

GitHub Actions runs a small Python program hourly and also supports manual runs. The program uses only Python's standard library, so the workflow needs no dependency installation.

The program requests Steam's search results for games that are both on special and currently free. It parses each result into a minimal record containing Steam app ID, title, and store URL, and accepts only results explicitly marked with a 100% discount.

The repository stores the last successfully observed set in `data/offers.json`. A successful run compares current app IDs with the stored IDs. On the first run, the stored set is empty, so all current results are new. Later runs send only games absent from the preceding successful observation. Removed games do not generate Telegram messages.

When the stored state changes, the workflow commits only `data/offers.json` back to the default branch. Scheduled workflow commits do not trigger another workflow run.

## Components

- `steam_free_games.py`: fetches and parses Steam results, compares state, formats Telegram messages, calls the Telegram Bot API, and writes state after successful processing.
- `data/offers.json`: the latest successfully observed app IDs and display data.
- `.github/workflows/check.yml`: hourly and manual GitHub Actions entry point, secret mapping, execution, and conditional state commit.
- `tests/`: behavior-focused tests for Steam parsing, state comparison, first-run behavior, message formatting, and failure safety.
- `README.md`: Telegram bot creation, chat ID discovery, GitHub repository setup, secrets, permissions, manual first run, and troubleshooting.

## Data Flow

1. GitHub Actions starts on an hourly cron schedule or by manual dispatch.
2. The script requests the Steam results page with a normal browser user agent and a finite timeout.
3. The parser retains only valid game rows that have an app ID, title, URL, and explicit 100% discount.
4. If the response is unsuccessful or no recognizable result structure exists, the run fails and leaves stored state untouched.
5. The script loads `data/offers.json`; a missing file means the first run.
6. It sends one Russian Telegram message containing all newly discovered games and their Steam links. If there are no new games, it sends nothing.
7. Only after successful Telegram delivery, the script atomically writes the complete current set to `data/offers.json`.
8. The workflow commits the state file only when it changed.

## Configuration and Secrets

The workflow reads two GitHub Actions secrets:

- `TELEGRAM_BOT_TOKEN`: token issued by BotFather.
- `TELEGRAM_CHAT_ID`: numeric ID of the private chat, group, or channel receiving notifications.

The repository workflow receives `contents: write` permission only so it can commit the state file. Secrets are never written to logs or files.

## Error Handling

- Network, timeout, HTTP, parse, Telegram, and invalid-state errors make the job fail visibly.
- Stored state is not changed if Steam cannot be parsed safely or Telegram rejects the notification.
- A retry therefore attempts the same notification again instead of silently losing it.
- Duplicate app IDs in Steam output are collapsed before comparison and messaging.
- Telegram text is HTML-escaped and store links are constructed from numeric app IDs.

## Testing and Acceptance Criteria

Automated tests use saved minimal HTML fragments and local fakes; they do not depend on live Steam or Telegram availability.

The implementation is accepted when:

- a first run with two current giveaways sends both;
- a later run sends only newly added app IDs;
- removed games produce no notification;
- unchanged results produce no notification;
- only explicit 100%-discount game rows are accepted;
- malformed or blocked Steam responses do not overwrite state;
- failed Telegram delivery does not overwrite state;
- tests pass using the documented command;
- the workflow can also be launched manually for setup verification.

## Non-goals

- Notifications when a giveaway ends.
- A Telegram command interface or polling bot.
- A database, web dashboard, paid service, or always-on process.
- Price-history verification beyond Steam's current search result.
