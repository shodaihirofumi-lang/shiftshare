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
  getHoldings, addHolding, deleteHolding, sellHolding, getRealized,
  getNotes, addNote, deleteNote, toggleNote,
  getMemos, addMemo, deleteMemo, editMemo,
  getNotifiedOff, markNotifiedOff,
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
// 売買時の自動メモ生成
const CUR_SYM = { JPY: '¥', USD: '$' };
function curSymStr(cur) { return CUR_SYM[cur] || (cur + ' '); }
function inferCurrency(ticker) {
  const t = String(ticker || '').toUpperCase();
  // 「.T」付きでも、生の4〜5桁コード（addHoldingで .T が付く前のユーザー入力）でもJPY扱い
  if (t.endsWith('.T') || /^\d{4,5}$/.test(t)) return 'JPY';
  return 'USD';
}
function fmtMoney(n, cur) {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  // 円は整数、USDは小数2桁まで
  return cur === 'USD' ? r.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Math.round(r).toLocaleString();
}
function displayName(ticker, name) {
  const tk = String(ticker || '').toUpperCase();
  return name && String(name).trim() ? `${String(name).trim()}（${tk}）` : tk;
}
function buildBuyMemoText({ ticker, shares, cost, name }) {
  const cur = inferCurrency(ticker);
  const sym = curSymStr(cur);
  const total = cost * shares;
  return `【買】${displayName(ticker, name)}\n${shares}株 × ${sym}${fmtMoney(cost, cur)} = ${sym}${fmtMoney(total, cur)}`;
}
function buildSellMemoText({ ticker, shares, sellPrice, realized, currency, name }) {
  const cur = currency || inferCurrency(ticker);
  const sym = curSymStr(cur);
  const total = sellPrice * shares;
  const realAbs = Math.abs(realized);
  const realSign = realized >= 0 ? '+' : '−';
  return `【売】${displayName(ticker, name)}\n${shares}株 × ${sym}${fmtMoney(sellPrice, cur)} = ${sym}${fmtMoney(total, cur)}\n実現損益 ${realSign}${sym}${fmtMoney(realAbs, cur)}`;
}

app.post('/api/holding', async (req, res) => {
  const { person, ticker, shares, cost, name } = req.body;
  if (!['mine', 'hers'].includes(person)) return res.status(400).json({ error: 'person は mine または hers のみ' });
  if (!ticker || !String(ticker).trim()) return res.status(400).json({ error: '銘柄コードが必要です' });
  const id = await addHolding(req.body);
  // 価格を入れた買い注文だけメモに自動記録（cost=0は単なる株数追加なのでメモしない）
  if (Number(shares) > 0 && Number(cost) > 0) {
    try { await addMemo({ person, text: buildBuyMemoText({ ticker, shares: Number(shares), cost: Number(cost), name }) }); } catch {}
  }
  res.json({ success: true, id });
});
app.post('/api/holding/delete', async (req, res) => {
  await deleteHolding(req.body.id);
  res.json({ success: true });
});
app.post('/api/holding/sell', async (req, res) => {
  try {
    const r = await sellHolding(req.body);
    // 売却時は必ずメモに自動記録（実現損益込み）
    try {
      await addMemo({
        person: req.body.person,
        text: buildSellMemoText({
          ticker: req.body.ticker,
          shares: Number(req.body.shares),
          sellPrice: Number(req.body.sellPrice),
          realized: r.realized,
          currency: r.currency,
          name: r.name,
        }),
      });
    } catch {}
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/realized', (_req, res) => res.json(getRealized()));
// テクニカル指標（週足）
function smaCalc(arr, n) { if (arr.length < n) return null; return arr.slice(-n).reduce((a, b) => a + b, 0) / n; }
function rsiCalc(arr, period = 14) {
  if (arr.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = arr.length - period; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function techSignal(price, closes) {
  const ma13 = smaCalc(closes, 13), ma26 = smaCalc(closes, 26), r = rsiCalc(closes, 14);
  if (ma13 == null || ma26 == null || r == null) return null;
  const up = ma13 > ma26, above = price >= ma13;
  let sig;
  if (r >= 70) sig = 'sell';          // 買われすぎ
  else if (r <= 30) sig = 'buy';      // 売られすぎ（反発期待）
  else if (up && above) sig = 'buy';  // 上昇トレンド＋過熱でない
  else if (!up && !above) sig = 'sell'; // 下降トレンド
  else sig = 'hold';                  // 様子見
  return { signal: sig, rsi: Math.round(r) };
}
// 複数銘柄の現在値＋週足テクニカル判定（Yahoo Finance）
app.get('/api/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
  const out = {};
  for (const sym of symbols) {
    // 4〜5桁の日本株コードは .T を補う（古いデータ対応）。結果は元のキーで返す
    const ySym = /^\d{4,5}$/.test(sym) ? sym + '.T' : sym;
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1wk&range=2y`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(r => r.json());
      const r0 = j.chart?.result?.[0];
      const m = r0?.meta;
      if (m && m.regularMarketPrice != null) {
        const closes = (r0.indicators?.quote?.[0]?.close || []).filter(x => x != null);
        const t = techSignal(m.regularMarketPrice, closes);
        out[sym] = {
          price: m.regularMarketPrice,
          currency: m.currency || 'JPY',
          name: m.shortName || m.longName || sym,
          signal: t?.signal || null,
          rsi: t?.rsi ?? null,
        };
      }
    } catch { /* skip */ }
  }
  res.json(out);
});

// ── 日別ポートフォリオ評価額（保有株の日足履歴から計算）──
app.get('/api/portfolio-history', async (_req, res) => {
  const hold = getHoldings();
  if (!hold.length) return res.json({ history: [] });
  let usdjpy = 150;
  try {
    const fx = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json());
    const p = fx.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p) usdjpy = p;
  } catch { /* default */ }
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const perHolding = [];
  const allDates = new Set();
  for (const h of hold) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.ticker)}?interval=1d&range=1y`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json());
      const r0 = j.chart?.result?.[0];
      if (!r0) continue;
      const ts = r0.timestamp || [];
      const closes = r0.indicators?.quote?.[0]?.close || [];
      const fxRate = (r0.meta?.currency === 'USD') ? usdjpy : 1;
      const person = h.person === 'hers' ? 'hers' : 'mine';
      const m = {};
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] == null) continue;
        const key = fmt.format(new Date(ts[i] * 1000));
        m[key] = closes[i] * h.shares * fxRate;
        allDates.add(key);
      }
      if (Object.keys(m).length) perHolding.push({ person, m });
    } catch { /* skip */ }
  }
  // 日付の和集合を作り、各銘柄は直近値を前方補完（取引日が違う銘柄でも誤差なく合算）
  const dates = [...allDates].sort();
  const last = perHolding.map(() => 0);
  const seen = perHolding.map(() => false);
  const history = [];
  for (const date of dates) {
    let mine = 0, hers = 0;
    perHolding.forEach((ph, idx) => {
      if (ph.m[date] != null) { last[idx] = ph.m[date]; seen[idx] = true; }
      if (seen[idx]) { if (ph.person === 'hers') hers += last[idx]; else mine += last[idx]; }
    });
    history.push({ date, mine: Math.round(mine), hers: Math.round(hers) });
  }
  res.json({ history });
});

// ── 個別銘柄の値動き（チャート用）──
app.get('/api/stock-history', async (req, res) => {
  const sym0 = String(req.query.symbol || '').trim();
  const sym = /^\d{4,5}$/.test(sym0) ? sym0 + '.T' : sym0;
  if (!sym) return res.status(400).json({ error: 'symbol が必要です' });
  const range = ['1mo', '6mo', '1y', '5y'].includes(req.query.range) ? req.query.range : '6mo';
  const interval = (range === '1y' || range === '5y') ? '1wk' : '1d';
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then(r => r.json());
    const r0 = j.chart?.result?.[0];
    if (!r0) throw new Error('データなし');
    const ts = r0.timestamp || [];
    const closes = r0.indicators?.quote?.[0]?.close || [];
    const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: '2-digit', month: 'numeric', day: 'numeric' });
    const history = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      history.push({ date: fmt.format(new Date(ts[i] * 1000)), close: Math.round(closes[i] * 100) / 100 });
    }
    res.json({ name: r0.meta?.shortName || sym, currency: r0.meta?.currency || 'JPY', history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── BOARD（ふたりの掲示板：行きたい所・やりたいこと）──
app.get('/api/notes', (_req, res) => res.json(getNotes()));
app.post('/api/note', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '内容が必要です' });
  }
  const id = await addNote(req.body);
  res.json({ success: true, id });
});
app.post('/api/note/delete', async (req, res) => {
  await deleteNote(req.body.id);
  res.json({ success: true });
});
app.post('/api/note/toggle', async (req, res) => {
  await toggleNote(req.body.id);
  res.json({ success: true });
});

// ── MEMOS（ひろ/ちかそれぞれの個人メモ）──
app.get('/api/memos', (_req, res) => res.json(getMemos()));
app.post('/api/memo', async (req, res) => {
  const { person, text } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person が不正です' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '内容が必要です' });
  }
  const id = await addMemo(req.body);
  res.json({ success: true, id });
});
app.post('/api/memo/delete', async (req, res) => {
  await deleteMemo(req.body.id);
  res.json({ success: true });
});
app.post('/api/memo/edit', async (req, res) => {
  const { id, text } = req.body;
  if (!id) return res.status(400).json({ error: 'id が必要です' });
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '内容が必要です' });
  }
  const ok = await editMemo(id, text);
  if (!ok) return res.status(404).json({ error: 'メモが見つかりません' });
  res.json({ success: true });
});

// ── ふたり休み接近通知（今日〜3日後を確認、未通知の日にpush）──
app.get('/api/check-both-off-notify', async (_req, res) => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.json({ sent: 0, reason: 'no vapid' });
  const jstFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [tY, tM, tD] = jstFmt.format(new Date()).split('-').map(Number);
  const shifts = getAllShifts();
  const subs = getPushSubscriptions();
  const notified = getNotifiedOff();
  let sent = 0;
  const fired = [];
  for (let d = 0; d <= 3; d++) {
    const dt = new Date(tY, tM - 1, tD); dt.setDate(dt.getDate() + d);
    const y = dt.getFullYear(), m = dt.getMonth() + 1, day = dt.getDate();
    const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (notified[key]) continue;
    const mine = shifts.find(s => s.year === y && s.month === m && s.day === day && s.person === 'mine');
    const hers = shifts.find(s => s.year === y && s.month === m && s.day === day && s.person === 'hers');
    if (!mine || !hers) continue;
    if (mine.shift_type !== 'off' || hers.shift_type !== 'off') continue;
    const dayLabel = d === 0 ? '今日' : d === 1 ? '明日' : `${d}日後`;
    const payload = JSON.stringify({
      title: '★ ふたり休み',
      body: `${dayLabel}（${m}月${day}日）はふたり共通のお休みです`,
    });
    for (const sub of subs) {
      webpush.sendNotification(sub, payload).catch(() => {});
    }
    await markNotifiedOff(key);
    sent++;
    fired.push(key);
  }
  res.json({ sent, fired });
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
  if (!tok.access_token) {
    const err = new Error(`access_token取得失敗: ${tok.error || ''} ${tok.error_description || ''}`.trim());
    err.tokError = tok.error || 'unknown'; // 'invalid_grant'=refresh token失効（テストモード7日経過/取り消し等）
    throw err;
  }
  return tok.access_token;
}
async function fetchGoogleTasks(refreshToken) {
  const accessToken = await googleAccessToken(refreshToken);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const lists = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', { headers }).then(r => r.json());
  const items = [];
  let totalTasks = 0;
  for (const list of (lists.items || [])) {
    const tasks = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks?showCompleted=false&maxResults=100`, { headers }).then(r => r.json());
    for (const t of (tasks.items || [])) {
      totalTasks++;
      if (!t.due) continue; // 期限のあるタスクのみカレンダーに表示
      const d = new Date(t.due);
      items.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), title: (t.title || '(無題)').toString().slice(0, 80) });
    }
  }
  return { items, listsCount: (lists.items || []).length, totalTasks, withDueCount: items.length };
}
app.get('/api/gtasks', async (_req, res) => {
  const tokens = getGtasksTokens();
  const result = { mine: [], hers: [] };
  const diagnostics = {};
  for (const p of ['mine', 'hers']) {
    if (!tokens[p]) { diagnostics[p] = { connected: false }; continue; }
    try {
      const r = await fetchGoogleTasks(tokens[p]);
      result[p] = r.items;
      diagnostics[p] = { connected: true, lists: r.listsCount, totalTasks: r.totalTasks, withDue: r.withDueCount };
    } catch (e) {
      console.error('gtasks', p, e.message);
      const expired = e.tokError === 'invalid_grant';
      diagnostics[p] = { connected: true, error: expired ? 'expired' : 'fetch_failed', message: e.message };
      if (expired) {
        // refresh tokenが失効しているので削除（次回はstatus=falseになる）
        await deleteGtasksToken(p);
        diagnostics[p].cleared = true;
      }
    }
  }
  res.json({ ...result, diagnostics });
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
