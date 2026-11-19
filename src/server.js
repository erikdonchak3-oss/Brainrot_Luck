'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

if (!BOT_TOKEN || !WEBAPP_URL || !JWT_SECRET) {
  console.error('Missing required environment variables: BOT_TOKEN, WEBAPP_URL, JWT_SECRET');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

function validateInitData(initData) {
  if (typeof initData !== 'string' || !initData || initData.length > 16384) throw new Error('Missing Telegram initData');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^([a-f0-9]{64})$/i.test(hash) || !Number.isFinite(authDate)) throw new Error('Malformed Telegram initData');
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > 86400) throw new Error('Telegram initData expired');
  params.delete('hash');
  params.delete('signature');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
  const secretKey = crypto.createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid Telegram signature');
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { throw new Error('Invalid Telegram user'); }
  if (!user || !Number.isSafeInteger(Number(user.id))) throw new Error('Telegram user is missing');
  return user;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'brainrotluck' });
    req.playerId = String(payload.sub);
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}

async function ensurePlayer(user) {
  const q = `INSERT INTO players(telegram_id, username, first_name, last_name, photo_url)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name, photo_url=EXCLUDED.photo_url, updated_at=NOW()
    RETURNING telegram_id, username, first_name, last_name, photo_url, state, revision`;
  const { rows } = await pool.query(q, [String(user.id), user.username || null, user.first_name || null, user.last_name || null, user.photo_url || null]);
  return rows[0];
}

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'brainrotluck' }); }
  catch { res.status(503).json({ ok: false, error: 'database_unavailable' }); }
});

app.post('/api/auth/telegram', async (req, res) => {
  try {
    const user = validateInitData(req.body?.initData);
    const player = await ensurePlayer(user);
    const token = jwt.sign({ username: user.username || null }, JWT_SECRET, { subject: String(user.id), issuer: 'brainrotluck', expiresIn: '12h' });
    res.json({ token, player: { id: String(player.telegram_id), username: player.username, firstName: player.first_name, photoUrl: player.photo_url }, state: player.state, revision: Number(player.revision) });
  } catch (err) { res.status(401).json({ error: err.message || 'Telegram authorization failed' }); }
});

app.get('/api/state', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT state, revision FROM players WHERE telegram_id=$1', [req.playerId]);
  if (!rows[0]) return res.status(404).json({ error: 'player_not_found' });
  res.json({ state: rows[0].state, revision: Number(rows[0].revision) });
});

// Compatibility persistence endpoint for the existing HTML game. The server stores a
// separate snapshot per authenticated Telegram account. It is NOT an anti-cheat economy
// API: client-originated values must be migrated to server-validated game commands before
// tokens/rewards can be considered tamper-proof.
app.put('/api/state', auth, async (req, res) => {
  const state = req.body?.state;
  const baseRevision = Number(req.body?.revision);
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Number.isSafeInteger(baseRevision)) return res.status(400).json({ error: 'invalid_state' });
  const allowed = {
    tokens: Math.max(0, Math.floor(Number(state.tokens) || 0)),
    collection: Array.isArray(state.collection) ? state.collection.slice(0, 5000) : [],
    stats: state.stats && typeof state.stats === 'object' ? state.stats : {},
    timers: state.timers && typeof state.timers === 'object' ? state.timers : {},
    profile: state.profile && typeof state.profile === 'object' ? state.profile : {}
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('UPDATE players SET state=$1::jsonb, revision=revision+1, updated_at=NOW() WHERE telegram_id=$2 AND revision=$3 RETURNING revision', [JSON.stringify(allowed), req.playerId, baseRevision]);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'revision_conflict' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, revision: Number(result.rows[0].revision) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('state save failed', err);
    res.status(500).json({ error: 'state_save_failed' });
  } finally { client.release(); }
});

const bot = new Telegraf(BOT_TOKEN);
bot.start(async ctx => {
  await ctx.reply('Добро пожаловать в BrainrotLuck! Нажми кнопку ниже, чтобы открыть игру.', Markup.inlineKeyboard([
    Markup.button.webApp('🎮 Играть в BrainrotLuck', WEBAPP_URL)
  ]));
});
bot.command('game', ctx => ctx.reply('Открывай BrainrotLuck:', Markup.inlineKeyboard([Markup.button.webApp('🎮 Открыть игру', WEBAPP_URL)])));

if (WEBHOOK_SECRET) {
  app.post('/telegram/webhook', (req, res, next) => {
    if (req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return res.sendStatus(403);
    next();
  }, (req, res) => bot.handleUpdate(req.body, res));
}

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

(async () => {
  await pool.query(require('node:fs').readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  app.listen(PORT, async () => {
    console.log(`BrainrotLuck listening on ${PORT}`);
    if (WEBHOOK_SECRET) {
      try { await bot.telegram.setWebhook(`${WEBAPP_URL.replace(/\/$/, '')}/telegram/webhook`, { secret_token: WEBHOOK_SECRET }); console.log('Telegram webhook configured'); }
      catch (err) { console.error('Telegram webhook setup failed:', err.message); }
    } else {
      bot.launch().then(() => console.log('Telegram bot polling started')).catch(err => console.error('Telegram bot launch failed:', err));
    }
  });
})().catch(err => { console.error(err); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
