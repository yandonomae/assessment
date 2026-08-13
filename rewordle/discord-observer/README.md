# Wordle Round 2 Observer

Temporary Discord Gateway observer used to answer one question before building the real Round 2 game:

> Does the official NYT Wordle Discord Activity expose enough first-round state (especially actual guesses) in bot-visible Discord Gateway/message payloads?

This is intentionally an **observer**, not the final game.

## What it records

While a short test is active in one Discord channel, the bot records:

- raw `MESSAGE_CREATE` / `MESSAGE_UPDATE` payloads
- message deletes and reactions
- hydrated discord.js message objects
- selected thread/channel events
- selected voice events in the same guild, in case launching/using an Activity leaves useful side effects

It writes JSONL locally and can export a single JSON attachment back into Discord.

## Discord setup

1. Open Discord Developer Portal and create an Application.
2. Open **Bot** and create/reset the bot token.
3. Turn on **Message Content Intent** under Privileged Gateway Intents.
4. Under **Installation**, install the app to your test server with Bot permissions:
   - View Channels
   - Read Message History
   - Send Messages
   - Attach Files
5. Never paste the bot token into ChatGPT. Put it directly into the hosting service's environment variables as `DISCORD_TOKEN`.

## Run locally

Requires Node.js 22.12+.

```bash
cp .env.example .env
# edit .env and set DISCORD_TOKEN
npm install
npm start
```

Health check: `http://localhost:3000/health`

## Test flow

In the Discord channel where the official Wordle Activity posts/updates its progress:

1. `!w2 watch`
2. Play exactly one official Wordle game.
3. `!w2 stop`
4. Optional: `!w2 inspect`
5. `!w2 export`
6. Upload the resulting `wordle-observer-....json` to the ChatGPT conversation working on Round 2.

`!w2 watch` clears the previous capture so the exported file stays focused and small.

## Railway deployment

This project is a normal always-on Node worker. Railway detects `npm start` from `package.json`; no public domain is required for Discord Gateway operation.

Set these service variables:

```text
DISCORD_TOKEN=<your token>
DATA_DIR=/data
```

`CONTROL_USER_ID` is optional. If set, only that Discord user can run `!w2` commands.

A Railway Volume mounted at `/data` is optional for this one-game test. Without it, export still works as long as the service does not restart during the test.

## Privacy / scope

The observer deliberately watches only the channel where `!w2 watch` was issued for message events. Voice events are limited to the same guild during the short observation window. Use a dedicated test channel and run `!w2 stop` immediately after the Wordle game.

## What we do after export

We inspect:

- `application_id`
- `interaction_metadata`
- `embeds`
- `components`
- attachments
- message-update deltas
- any five-letter guess-like values or state identifiers
- activity-related side events

If actual guesses or a usable state reference are visible, the real Round 2 bot can keep the official Wordle Activity as Round 1. If not, the fallback is to own Round 1 as our own Discord Activity so the full guess history is available by design.
