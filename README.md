# BrainrotLuck — Telegram Mini App foundation

This package keeps the supplied game HTML, adds Telegram Web Apps initialization, a Node.js/Express service, PostgreSQL player records, Telegram `initData` verification, and a `/start` bot entry point.

## What is included

- `public/index.html` — original 7 MB game with the supplied artwork and existing case catalog retained.
- `public/telegram-bridge.js` — Telegram WebApp SDK initialization, signed `initData` authentication, server state hydration, and cloud snapshot persistence.
- `src/server.js` — Express API, Telegram HMAC validation, JWT session, per-Telegram-ID player state, PostgreSQL schema initialization, and Telegraf bot.
- `db/schema.sql` — player state and idempotent event-ledger table.
- `render.yaml` — Render web service + PostgreSQL blueprint.

## Deploy to Render

1. Create a GitHub repository and upload the contents of this folder (not the folder wrapper).
2. In Render choose **New → Blueprint** and select the repository. Render will create the web service and PostgreSQL database.
3. In the web service Environment settings set:
   - `BOT_TOKEN` — token from BotFather. **Enter it directly in Render; never commit it or send it in chat.**
   - `WEBAPP_URL` — the public HTTPS URL of the Render service, e.g. `https://brainrotluck-miniapp.onrender.com`.
   - `TELEGRAM_WEBHOOK_SECRET` — generate a random value if the blueprint did not generate one.
4. Deploy. Check `https://YOUR-SERVICE.onrender.com/health` returns `{ "ok": true }`.
5. In BotFather configure the bot's menu button / Main Mini App URL to the same `WEBAPP_URL`. The bot `/start` command also replies with a Web App button.
6. Open the bot on a phone and press **Start** / **Играть**.

`DATABASE_URL` and `JWT_SECRET` are provisioned by the Render blueprint. Do not expose either value publicly.

## Local development

Requires Node.js 20+ and PostgreSQL. Copy `.env.example` to `.env`, fill in local values, then:

```bash
npm install
npm start
```

Telegram authentication is intentionally required for cloud state APIs. Opening the page in a normal browser without Telegram runs the original local-preview mode.

## Important implementation status / security boundary

The existing HTML contains a large client-side game economy. This package persists a per-user cloud snapshot and authenticates the Telegram account, but it does **not yet make every economy operation server-authoritative**. The current game still chooses roulette outcomes and applies token/inventory mutations in the browser before the snapshot is sent. A modified client could therefore forge balances or rewards. Do not treat this build as a tamper-proof economy or launch it with valuable paid currency until case opening, skip settlement, sales, upgrader, dice, daily rewards, and admin actions are migrated to server-side transactional commands using the included event ledger and a server-owned reward catalogue.

The roulette batch renderer was patched so ×1 shows its selected reward and ×3/×5 show a settlement summary after the existing animation completes. This is a source-level fix; it has not been verified in a live Telegram client or exhaustively tested against every case. The legacy code has multiple later case-setup scripts and image-heavy reward definitions, so each case still needs regression testing after deployment.

## Environment variables

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Telegram bot token (Render secret only) |
| `WEBAPP_URL` | Public HTTPS Mini App URL |
| `DATABASE_URL` | Render PostgreSQL connection string |
| `JWT_SECRET` | Signs authenticated API sessions |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook request verification |
| `NODE_ENV` | `production` on Render |

## Next required hardening before public launch

1. Extract the full case/reward catalogue into a server-owned data module without losing image references, probabilities, or special-case setup.
2. Implement atomic `open-case` transactions: verify cooldown and balance, debit once, draw server-side, save each reward and an idempotency key, then return the preselected result to the animation.
3. Implement server-side settlement for skip and normal animation completion (the animation must never decide whether a reward is granted).
4. Migrate upgrader, Color Dice, exchange, sales, daily reward, and free-case cooldown to validated server commands.
5. Add integration tests for every case ×1/×3/×5, skip, duplicate requests, insufficient funds, reload persistence, and Telegram mobile viewport.
