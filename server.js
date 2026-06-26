const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN      = process.env.BOT_TOKEN;
const TG_CHANNEL     = process.env.CHANNEL_USERNAME || '@biopractika_ru';
const VK_TOKEN       = process.env.VK_SERVICE_TOKEN;
const VK_GROUP_ID    = process.env.VK_GROUP_ID || '153098490';
const PORT           = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      user_id    TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      username   TEXT,
      score      INTEGER NOT NULL DEFAULT 0,
      platform   TEXT DEFAULT 'tg',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}

// ── Telegram: проверка подписки ───────────────────────────────
// GET /check-sub?user_id=123
app.get('/check-sub', async (req, res) => {
  const { user_id } = req.query;
  console.log('TG check-sub, user_id:', user_id);
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!BOT_TOKEN) return res.json({ subscribed: true });
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${TG_CHANNEL}&user_id=${user_id}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok) return res.json({ subscribed: false, error: data.description });
    const subscribed = ['member','administrator','creator'].includes(data.result.status);
    res.json({ subscribed });
  } catch (e) {
    console.error('TG check-sub error:', e.message);
    res.status(500).json({ subscribed: false, error: e.message });
  }
});

// ── VK: проверка подписки ─────────────────────────────────────
// GET /vk/check-sub?user_id=123
app.get('/vk/check-sub', async (req, res) => {
  const { user_id } = req.query;
  console.log('VK check-sub, user_id:', user_id);
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!VK_TOKEN) return res.json({ subscribed: true });
  try {
    const url = `https://api.vk.com/method/groups.isMember?group_id=${VK_GROUP_ID}&user_id=${user_id}&access_token=${VK_TOKEN}&v=5.131`;
    const r = await fetch(url);
    const data = await r.json();
    console.log('VK API response:', JSON.stringify(data));
    if (data.error) {
      console.error('VK API error:', data.error);
      return res.json({ subscribed: false, error: data.error.error_msg });
    }
    res.json({ subscribed: data.response === 1 });
  } catch (e) {
    console.error('VK check-sub error:', e.message);
    res.status(500).json({ subscribed: false, error: e.message });
  }
});

// ── Сохранить результат (общий для TG и VK) ───────────────────
// POST /score  body: { user_id, first_name, username, score, platform }
app.post('/score', async (req, res) => {
  const { user_id, username, score, platform } = req.body;
  const first_name = req.body.first_name || username || 'Игрок';
  console.log('POST /score:', { user_id, first_name, username, score, platform });
  if (!user_id || score === undefined) {
    return res.status(400).json({ error: 'user_id, score required' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO scores (user_id, first_name, username, score, platform, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET first_name = EXCLUDED.first_name,
            username   = EXCLUDED.username,
            score      = GREATEST(scores.score, EXCLUDED.score),
            platform   = EXCLUDED.platform,
            updated_at = NOW()
      RETURNING *
    `, [String(user_id), first_name, username || null, score, platform || 'tg']);
    console.log('Score saved:', result.rows[0]);
    res.json({ ok: true });
  } catch (e) {
    console.error('score error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Глобальный лидерборд (все платформы) ─────────────────────
// GET /leaderboard
app.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT user_id, first_name, username, score, platform
      FROM scores ORDER BY score DESC LIMIT 10
    `);
    res.json({ leaderboard: rows });
  } catch (e) {
    console.error('leaderboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── VK лидерборд (только VK) ──────────────────────────────────
// GET /vk/leaderboard
app.get('/vk/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT user_id, first_name, username, score
      FROM scores WHERE platform = 'vk'
      ORDER BY score DESC LIMIT 10
    `);
    res.json({ leaderboard: rows });
  } catch (e) {
    console.error('vk leaderboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Выгрузка всех игроков в CSV ───────────────────────────────
// GET /leaderboard.csv
app.get('/leaderboard.csv', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT user_id, first_name, username, score, platform, updated_at
      FROM scores ORDER BY score DESC
    `);
    const csv = [
      'user_id,first_name,username,score,platform,updated_at',
      ...rows.map(r =>
        `${r.user_id},"${r.first_name}",${r.username||''},${ r.score},${r.platform},${r.updated_at}`
      )
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Biopractika API' }));

initDB()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
