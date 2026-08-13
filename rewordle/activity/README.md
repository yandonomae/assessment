# RE:WORDLE Discord Activity

Discord Activity version of the RE:WORDLE prototype.

## Game flow

1. Players who launch the same Discord Activity share the same `instanceId` room.
2. **Round 1** is a five-letter / six-guess Wordle-style game. Every submitted guess is stored by the Activity backend.
3. When everyone finishes, **Round 2** begins. Each player receives another player's Round 1 board: color patterns are visible, but the actual guess words are hidden. The final answer is visible.
4. Players reconstruct each hidden row. Each reconstruction attempt gets Wordle-style feedback against the hidden guess word.
5. The keyboard has an input/flag switch. In flag mode, clicking a key cycles its outer ring Yellow -> Green -> Black -> None. Flags are private client-side notes.
6. Lowest Round 2 move count wins.

With only one human player, starting the lobby adds `RE:BOT`, whose Round 1 path comes from deliberately imperfect presets so solo testing stays useful.

## Frontend / Vercel

Set the Vercel Root Directory to:

`/rewordle/activity`

Environment variable:

`VITE_DISCORD_CLIENT_ID=<your Discord Application ID>`

`VITE_API_BASE` can stay `/api` when running through Discord's proxy.

## Discord Developer Portal

Use the same Discord application for the Activity and backend credentials.

- OAuth2 Redirect: `https://127.0.0.1`
- Enable Activities.
- URL Mappings (put the more specific prefix first):
  - `/api` -> your Railway backend hostname (hostname only, no `https://`)
  - `/` -> your Vercel frontend hostname (hostname only, no `https://`)

## Backend / Railway

The existing Railway service at `/rewordle/discord-observer` now starts `src/activity-server.js`.

Required variables:

- `DISCORD_CLIENT_ID` - same Application ID used by the frontend
- `DISCORD_CLIENT_SECRET` - OAuth2 Client Secret
- `DISCORD_TOKEN` - bot token for the same application; used to verify active Activity instances
- `PORT` - supplied by Railway

`ACTIVITY_SKIP_INSTANCE_VERIFY=true` can temporarily disable the Activity Instance API check during development, but should not be used for production.

The backend keeps room state in memory keyed by Discord `instanceId`. That matches the Activity lifecycle well for an MVP. Rooms are automatically removed after six hours of inactivity. If the Railway process restarts, active games are lost; persistence can be added after gameplay is validated.
