import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import webpush from 'web-push';
import ical from 'node-ical';
import { parseShiftImages, parseExpenseAmount } from './aiParser.js';
import {
  initDb,
  getAllShifts, getUploadLog,
  savePushSubscription, getPushSubscriptions, saveShifts,
  saveAvatar, getAvatars, upsertShift,
  getEvents, addEvent, deleteEvent,
  getWages, saveWage,
  getLocations, saveLocation,
  getExpenses, addExpense, deleteExpense,
  getGcalUrls, saveGcalUrl,
  getGtasksTokens, saveGtasksToken, deleteGtasksToken,
  getHoldings, addHolding, deleteHolding,
} from './db.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '8mb' }));
app.use(express.static('static', {
  setHeaders: (res, filePath) => {
    // HTML（アプリ本体）は常に最新を取得させる（古いキャッシュで反映されない問題を防ぐ）
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

const PASSWORD = process.env.APP_PASSWORD || '1234';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@example.com';

// Google Tasks OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://shiftshare.onrender.com';
const GOOGLE_REDIRECT = `${BASE_URL}/api/google/callback`;
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks.readonly';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── LOGIN ──
app.post('/api/login', (req, res) => {
  if (req.body.password !== PASSWORD) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  res.json({ success: true });
});

// ── UPLOAD ──
app.post('/api/upload', upload.array('files', 2), async (req, res) => {
  const person = req.body.person;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  if (!req.files?.length) {
    return res.status(400).json({ error: 'ファイルがありません' });
  }

  const imagesB64 = req.files.map(f => f.buffer.toString('base64'));
  const mimeTypes = req.files.map(f => f.mimetype || 'image/jpeg');

  try {
    const shifts = await parseShiftImages(imagesB64, mimeTypes);
    await saveShifts(person, shifts);
    sendPushNotification(person);
    res.json({ success: true, count: shifts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: `AI解析エラー: ${e.message}` });
  }
});

// ── DATA ──
app.get('/api/shifts', (_req, res) => res.json(getAllShifts()));
app.get('/api/status', (_req, res) => res.json(getUploadLog()));
app.get('/api/vapid-key', (_req, res) => res.json({ publicKey: VAPID_PUBLIC }));

// ── 保有株（ポートフォリオ）──
app.get('/api/holdings', (_req, res) => res.json(getHoldings()));
app.post('/api/holding', async (req, res) => {
  const { person, ticker } = req.body;
  if (!['mine', 'hers'].includes(person)) return res.status(400).json({ error: 'person は mine または hers のみ' });
  if (!ticker || !String(ticker).trim()) return res.status(400).json({ error: '銘柄コードが必要です' });
  const id = await addHolding(req.body);
  res.json({ success: true, id });
});
app.post('/api/holding/delete', async (req, res) => {
  await deleteHolding(req.body.id);
  res.json({ success: true });
});
// 複数銘柄の現在値を取得（Yahoo Finance）
app.get('/api/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
  const out = {};
  for (const sym of symbols) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(r => r.json());
      const m = j.chart?.result?.[0]?.meta;
      if (m && m.regularMarketPrice != null) {
        out[sym] = {
          price: m.regularMarketPrice,
          prevClose: m.chartPreviousClose ?? m.previousClose ?? m.regularMarketPrice,
          currency: m.currency || 'JPY',
          name: m.shortName || m.longName || sym,
        };
      }
    } catch { /* skip */ }
  }
  res.json(out);
});

// ── 日経平均株価（Yahoo Finance・キー不要）──
app.get('/api/nikkei', async (_req, res) => {
  try {
    const j = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?interval=1d&range=1mo', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then(r => r.json());
    const r = j.chart?.result?.[0];
    if (!r) throw new Error('データ取得失敗');
    const ts = r.timestamp || [];
    const closes = r.indicators.quote[0].close || [];
    const history = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      const d = new Date(ts[i] * 1000);
      history.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, close: Math.round(closes[i] * 100) / 100 });
    }
    if (history.length < 2) throw new Error('データ不足');
    const latest = history[history.length - 1].close;
    const prev = history[history.length - 2].close;
    const change = Math.round((latest - prev) * 100) / 100;
    const changePct = Math.round((change / prev) * 10000) / 100;
    res.json({ latest, change, changePct, date: history[history.length - 1].date, history });
  } catch (e) {
    console.error('nikkei', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EDIT one day's shift manually ──
app.post('/api/shift', async (req, res) => {
  const { person, year, month, day } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  if (![year, month, day].every(Number.isInteger)) {
    return res.status(400).json({ error: '日付が不正です' });
  }
  await upsertShift(req.body);
  res.json({ success: true });
});

// ── EVENTS（日の予定）──
app.get('/api/events', (_req, res) => res.json(getEvents()));
app.post('/api/event', async (req, res) => {
  const { year, month, day, title } = req.body;
  if (![year, month, day].every(Number.isInteger)) {
    return res.status(400).json({ error: '日付が不正です' });
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'タイトルが必要です' });
  }
  const id = await addEvent(req.body);
  res.json({ success: true, id });
});
app.post('/api/event/delete', async (req, res) => {
  await deleteEvent(req.body.id);
  res.json({ success: true });
});

// ── WAGES（時給）──
app.get('/api/wages', (_req, res) => res.json(getWages()));
app.post('/api/wage', async (req, res) => {
  const { person, wage } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  await saveWage(person, wage);
  res.json({ success: true });
});

// ── EXPENSES（出費）──
app.get('/api/expenses', (_req, res) => res.json(getExpenses()));
app.post('/api/expense', async (req, res) => {
  const { person, year, month, day } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  if (![year, month, day].every(Number.isInteger)) {
    return res.status(400).json({ error: '日付が不正です' });
  }
  const id = await addExpense(req.body);
  res.json({ success: true, id });
});
app.post('/api/expense/delete', async (req, res) => {
  await deleteExpense(req.body.id);
  res.json({ success: true });
});
// レシート/決済画面の画像から金額を読み取る（保存はしない）
app.post('/api/expense/scan', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  try {
    const amount = await parseExpenseAmount(req.file.buffer.toString('base64'), req.file.mimetype || 'image/jpeg');
    res.json({ amount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: `金額の読み取りエラー: ${e.message}` });
  }
});

// ── GOOGLE TASKS（OAuth）──
app.get('/api/google/status', (_req, res) => {
  const t = getGtasksTokens();
  res.json({ configured: !!GOOGLE_CLIENT_ID, mine: !!t.mine, hers: !!t.hers });
});
app.get('/api/google/connect', (req, res) => {
  const person = req.query.person;
  if (!['mine', 'hers'].includes(person)) return res.status(400).send('person不正');
  if (!GOOGLE_CLIENT_ID) return res.status(500).send('Google連携が未設定です（管理者にお問い合わせください）');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: 'code',
    scope: TASKS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: person,
  });
  res.redirect(url);
});
app.get('/api/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !['mine', 'hers'].includes(state)) return res.status(400).send('認証に失敗しました');
  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code',
      }),
    }).then(r => r.json());
    if (!tok.refresh_token) throw new Error('refresh_tokenが取得できませんでした（既に連携済みの可能性。Googleアカウントのアクセス権を一度削除して再試行してください）');
    await saveGtasksToken(state, tok.refresh_token);
    res.redirect('/?gtasks=connected');
  } catch (e) {
    console.error('google callback', e.message);
    res.status(500).send(`連携エラー: ${e.message}`);
  }
});
app.post('/api/google/disconnect', async (req, res) => {
  if (['mine', 'hers'].includes(req.body.person)) await deleteGtasksToken(req.body.person);
  res.json({ success: true });
});

async function googleAccessToken(refreshToken) {
  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  }).then(r => r.json());
  return tok.access_token;
}
async function fetchGoogleTasks(refreshToken) {
  const accessToken = await googleAccessToken(refreshToken);
  if (!accessToken) return [];
  const headers = { Authorization: `Bearer ${accessToken}` };
  const lists = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', { headers }).then(r => r.json());
  const out = [];
  for (const list of (lists.items || [])) {
    const tasks = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks?showCompleted=false&maxResults=100`, { headers }).then(r => r.json());
    for (const t of (tasks.items || [])) {
      if (!t.due) continue; // 期限のあるタスクのみカレンダーに表示
      const d = new Date(t.due);
      out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), title: (t.title || '(無題)').toString().slice(0, 80) });
    }
  }
  return out;
}
app.get('/api/gtasks', async (_req, res) => {
  const tokens = getGtasksTokens();
  const result = { mine: [], hers: [] };
  for (const p of ['mine', 'hers']) {
    if (!tokens[p]) continue;
    try { result[p] = await fetchGoogleTasks(tokens[p]); }
    catch (e) { console.error('gtasks', p, e.message); }
  }
  res.json(result);
});

// ── GOOGLE CALENDAR 連携 ──
app.get('/api/gcal-urls', (_req, res) => res.json(getGcalUrls()));
app.post('/api/gcal-url', async (req, res) => {
  const { person, url } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  await saveGcalUrl(person, url);
  res.json({ success: true });
});

// 日付・時刻は必ず日本時間(JST)で取り出す（サーバーはUTCのため）
const JST_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function gcalEntry(d, datetype) {
  const o = {};
  for (const p of JST_FMT.formatToParts(d)) o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    time: datetype === 'date' ? null : `${o.hour}:${o.minute}`,
  };
}
async function fetchGcalEvents(url, winStart, winEnd) {
  const data = await ical.async.fromURL(url);
  const out = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const title = (ev.summary || '(無題)').toString().slice(0, 80);
    if (ev.rrule) {
      for (const d of ev.rrule.between(winStart, winEnd, true)) out.push({ ...gcalEntry(d, ev.datetype), title });
    } else if (ev.start >= winStart && ev.start <= winEnd) {
      out.push({ ...gcalEntry(ev.start, ev.datetype), title });
    }
  }
  return out;
}
app.get('/api/gcal-events', async (_req, res) => {
  const urls = getGcalUrls();
  const now = new Date();
  const winStart = new Date(now.getTime() - 60 * 86400000);
  const winEnd = new Date(now.getTime() + 120 * 86400000);
  const result = { mine: [], hers: [] };
  for (const p of ['mine', 'hers']) {
    if (!urls[p]) continue;
    try { result[p] = await fetchGcalEvents(urls[p], winStart, winEnd); }
    catch (e) { console.error('gcal', p, e.message); }
  }
  res.json(result);
});

// ── LOCATIONS（居住地・天気用）──
app.get('/api/locations', (_req, res) => res.json(getLocations()));
app.post('/api/location', async (req, res) => {
  const { person, location } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  await saveLocation(person, location);
  res.json({ success: true });
});

// ── AVATARS ──
app.get('/api/avatars', (_req, res) => res.json(getAvatars()));
app.post('/api/avatar', async (req, res) => {
  const { person, image } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person は mine または hers のみ' });
  }
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: '画像データが不正です' });
  }
  await saveAvatar(person, image);
  res.json({ success: true });
});

// ── PUSH ──
app.post('/api/push/subscribe', async (req, res) => {
  await savePushSubscription(req.body);
  res.json({ success: true });
});

function sendPushNotification(uploader) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const label = uploader === 'hers' ? 'ちか' : 'ひろ';
  const payload = JSON.stringify({
    title: 'シフトが更新されました',
    body: `${label}のシフトが登録されました`,
  });
  for (const sub of getPushSubscriptions()) {
    webpush.sendNotification(sub, payload).catch(() => {});
  }
}

const PORT = process.env.PORT || 8000;
await initDb();
app.listen(PORT, () => {
  console.log(`\n  ShiftShare 起動中 → http://localhost:${PORT}\n`);
});
