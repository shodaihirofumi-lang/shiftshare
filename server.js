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
  getHoldings, addHolding, deleteHolding, editHolding, sellHolding, getRealized,
  getWatchlist, addWatchStock, removeWatchStock,
  getDemoTrades, addDemoTrade, removeDemoTrade,
  setHoldingTargets, markHoldingTargetFired, markHoldingEarningsNotified, getBuys,
  hasMoveAlert, markMoveAlert,
  getNotes, addNote, deleteNote, toggleNote,
  getMemos, addMemo, deleteMemo, editMemo, pinMemo, setMemoImage,
  getPhotos, addPhoto, deletePhoto, reloadPhotoCache,
  getDiaries, getDiary, setDiary, getMonthlyDiaries, setMonthlyDiary,
  getBookmarks, setBookmark,
  getNotifiedOff, markNotifiedOff,
  getGoals, addGoal, deleteGoal,
  getTargetPrices, addTargetPrice, deleteTargetPrice,
  getPushSettings, savePushSettings,
  exportAll, importAll,
} from './db.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static('static', {
  setHeaders: (res, filePath) => {
    // HTML（アプリ本体）は常に最新を取得させる（古いキャッシュで反映されない問題を防ぐ）
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// アクセス契機で定期レポートをチェック（常駐タイマーの代わり。中身は maybeSendScheduledReports）
app.use((req, res, next) => { maybeSendScheduledReports().catch(() => {}); next(); });

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
  if (t.endsWith('.T') || /^\d{3,5}[A-Z]?$/.test(t)) return 'JPY';
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
  const { person, ticker, name, shares, cost, price, currency, purchaseDate } = req.body;
  if (!['mine', 'hers'].includes(person)) return res.status(400).json({ error: 'person は mine または hers のみ' });
  if (!ticker || !String(ticker).trim()) return res.status(400).json({ error: '銘柄コードが必要です' });
  const id = await addHolding(req.body);
  // 購入を日記に自動追記（purchaseDateが指定されればその日、なければ今日）
  const buyPrice = cost || price;
  if (buyPrice && parseFloat(buyPrice) > 0 && shares) {
    try {
      const diaryDate = purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)
        ? purchaseDate
        : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
      const cur = currency || inferCurrency(ticker);
      const sym = cur === 'JPY' ? '¥' : '$';
      const note = `${name||ticker}を${shares}株購入 @${sym}${Number(buyPrice).toLocaleString()}`;
      const ex = getDiary(diaryDate) || {};
      const pd = ex[person] || {};
      await setDiary(diaryDate, { ...ex, [person]: { ...pd, raw: pd.raw ? pd.raw+'\n'+note : note, savedAt: Date.now() } });
    } catch {}
  }
  res.json({ success: true, id });
});
app.post('/api/holding/delete', async (req, res) => {
  await deleteHolding(req.body.id);
  res.json({ success: true });
});
// 保有銘柄の訂正（株数・平均取得単価・銘柄名）。売買履歴には触れない。
app.post('/api/holding/edit', async (req, res) => {
  const { id, name, shares, cost } = req.body;
  if (!id) return res.status(400).json({ error: 'idが必要です' });
  const nShares = Number(shares);
  const nCost = Number(cost);
  if (!Number.isFinite(nShares) || nShares <= 0) return res.status(400).json({ error: '株数が不正です' });
  if (!Number.isFinite(nCost) || nCost < 0) return res.status(400).json({ error: '取得単価が不正です' });
  const ok = await editHolding(id, { name, shares: nShares, cost: nCost });
  if (!ok) return res.status(404).json({ error: '銘柄が見つかりません' });
  res.json({ success: true });
});
app.post('/api/holding/sell', async (req, res) => {
  try {
    const r = await sellHolding(req.body);
    // 売却を今日の日記に自動追記
    const { person, shares, sellPrice, currency } = req.body;
    if (['mine','hers'].includes(person) && shares && sellPrice) {
      try {
        const jstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
        const sym = (currency||'JPY')==='JPY' ? '¥' : '$';
        const displayName = req.body.name || r.name || req.body.ticker || '';
        const realSign = (r.realized||0) >= 0 ? '+' : '';
        const realAmt = (currency||'JPY')==='JPY' ? Math.round(r.realized||0).toLocaleString() : (r.realized||0).toFixed(2);
        const note = `${displayName}を${shares}株売却 @${sym}${Number(sellPrice).toLocaleString()} (${realSign}${sym}${realAmt})`;
        const ex = getDiary(jstDate) || {};
        const pd = ex[person] || {};
        await setDiary(jstDate, { ...ex, [person]: { ...pd, raw: pd.raw ? pd.raw+'\n'+note : note, savedAt: Date.now() } });
      } catch {}
    }
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/realized', (_req, res) => res.json(getRealized()));
app.get('/api/buys', (_req, res) => res.json(getBuys()));
// 「もしHOLDし続けてたら」: 売却した銘柄の現在価格を取得し、未売却シナリオとの差分を返す
app.get('/api/hold-replay', async (_req, res) => {
  const realized = getRealized();
  if (!realized.length) return res.json([]);
  const tickers = [...new Set(realized.map(r => r.ticker).filter(Boolean))];
  const prices = {};
  for (const t of tickers) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=5d`, {
        headers: { 'User-Agent': YH_UA },
      }).then(r => r.json());
      const p = j.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p != null) prices[t] = p;
    } catch { /* skip this ticker */ }
  }
  const enriched = realized.map(r => {
    const curPrice = prices[r.ticker];
    if (curPrice == null) return { ...r, currentPrice: null, holdValue: null, holdDelta: null };
    const holdValue = r.shares * curPrice; // 売らずに保有してたら現在の評価額
    const soldValue = r.shares * r.sellPrice; // 実際に売却で得た金額
    const holdDelta = holdValue - soldValue; // 正=HOLDしてた方が得だった、負=売って正解
    return { ...r, currentPrice: curPrice, holdValue, holdDelta };
  });
  res.json(enriched);
});
// 取引履歴（買い＋売り）。チャートにマーカーを描画する用途。person/ticker でフィルタ可。
app.get('/api/transactions', (req, res) => {
  const { person, ticker } = req.query;
  const normTicker = (t) => { t = String(t || '').toUpperCase(); return /^\d{3,5}[A-Z]?$/.test(t) ? t + '.T' : t; };
  const tk = ticker ? normTicker(ticker) : null;
  const buys = getBuys().map(b => ({ ...b, type: 'buy' }));
  const sells = getRealized().map(s => ({ ...s, type: 'sell', price: s.sellPrice }));
  let all = [...buys, ...sells];
  if (person) all = all.filter(x => x.person === person);
  if (tk) all = all.filter(x => x.ticker === tk);
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  res.json(all);
});

// 売買の振り返りをAIが分析（買い＋売り＋理由メモ＋実現損益から傾向を指摘）
app.get('/api/trade-review', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが設定されていません' });
  const person = ['mine', 'hers'].includes(req.query.person) ? req.query.person : null;
  let buys = getBuys().map(b => ({ ...b, type: 'buy' }));
  let sells = getRealized().map(s => ({ ...s, type: 'sell' }));
  if (person) { buys = buys.filter(b => b.person === person); sells = sells.filter(s => s.person === person); }
  const all = [...buys, ...sells].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (all.length < 2) return res.status(400).json({ error: '分析するには売買記録が少なすぎます（2件以上必要）' });
  const lines = all.map(t => {
    const d = new Date(t.ts || 0);
    const ds = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const who = t.person === 'hers' ? 'ちか' : 'ひろ';
    const nm = (t.name && t.name.trim()) ? t.name.trim() : t.ticker;
    const sym = (t.currency || 'JPY') === 'JPY' ? '¥' : '$';
    if (t.type === 'buy') return `${ds} ${who} 買 ${nm} ${t.shares}株 @${sym}${t.price}${t.reason ? `（理由:${t.reason}）` : ''}`;
    const r = t.realized || 0;
    return `${ds} ${who} 売 ${nm} ${t.shares}株 @${sym}${t.sellPrice} 実現${r >= 0 ? '+' : ''}${sym}${Math.round(r)}${t.reason ? `（理由:${t.reason}）` : ''}`;
  }).join('\n');
  const personName = person === 'mine' ? 'ひろ' : person === 'hers' ? 'ちか' : null;
  const prompt = `あなたは個人投資家のやさしい売買コーチです。${personName ? `${personName}の` : ''}以下の売買記録から、良かった点と改善点を具体的に指摘してください。
形式：
・最初に1〜2文の総評
・「👍 良い点」を2〜3個（箇条書き）
・「🔧 改善点」を2〜3個（箇条書き。例：損切りが早い/遅い、利確が早すぎ、根拠なき売買、特定銘柄への偏り など）
・最後に一言アドバイス
専門用語は避け、励ます口調で。データにないことは推測しすぎないこと。

売買記録:
${lines}`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error?.message || `API error ${response.status}`); }
    const data = await response.json();
    res.json({ text: data.content?.[0]?.text?.trim() || '', count: all.length });
  } catch (e) {
    console.error('[trade-review]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 配当（インカム）: 各保有株の過去1年の配当履歴から年間配当・利回りを計算
app.get('/api/dividends', async (_req, res) => {
  const holdings = getHoldings();
  if (!holdings.length) return res.json({ byHolding: [], totals: { mine: 0, hers: 0, combined: 0 }, exCalendar: [], usdjpy: null });
  let usdjpy = 150;
  try {
    const fx = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1d&range=5d', { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
    const p = fx.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p) usdjpy = p;
  } catch {}
  const yearAgo = Date.now() - 365 * 86400000;
  const tickers = [...new Set(holdings.map(h => h.ticker))];
  const info = {};
  for (const sym of tickers) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y&events=div`, {
        headers: { 'User-Agent': YH_UA },
      }).then(r => r.json());
      const r0 = j.chart?.result?.[0];
      const divs = r0?.events?.dividends ? Object.values(r0.events.dividends) : [];
      const ttm = divs.filter(d => (d.date * 1000) >= yearAgo).reduce((a, d) => a + (d.amount || 0), 0);
      const lastEx = divs.length ? Math.max(...divs.map(d => d.date * 1000)) : null;
      info[sym] = { price: r0?.meta?.regularMarketPrice ?? null, ttm, lastEx };
    } catch { info[sym] = { price: null, ttm: 0, lastEx: null }; }
  }
  const byHolding = [];
  const totals = { mine: 0, hers: 0, combined: 0 };
  const exCalendar = [];
  for (const h of holdings) {
    const inf = info[h.ticker] || {};
    const cur = h.ticker.endsWith('.T') ? 'JPY' : 'USD';
    const divPS = inf.ttm || 0;
    const annual = divPS * (h.shares || 0);
    const annualJpy = cur === 'USD' ? annual * usdjpy : annual;
    const yld = (inf.price && divPS) ? (divPS / inf.price * 100) : 0;
    if (annualJpy > 0) totals[h.person] = (totals[h.person] || 0) + annualJpy;
    byHolding.push({ id: h.id, person: h.person, ticker: h.ticker, name: h.name || '', shares: h.shares, currency: cur, price: inf.price, divPerShare: divPS, annual, annualJpy, yield: yld, lastEx: inf.lastEx });
    if (inf.lastEx && divPS > 0) exCalendar.push({ person: h.person, ticker: h.ticker, name: h.name || '', currency: cur, lastEx: inf.lastEx, amount: divPS });
  }
  totals.combined = (totals.mine || 0) + (totals.hers || 0);
  byHolding.sort((a, b) => b.annualJpy - a.annualJpy);
  exCalendar.sort((a, b) => b.lastEx - a.lastEx);
  res.json({ byHolding, totals, exCalendar, usdjpy });
});

// 決算カレンダー: 手動入力した決算発表日を持つ保有株を日付順に返す
app.get('/api/earnings', (_req, res) => {
  const jstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const today = new Date(jstDate + 'T00:00:00+09:00');
  const list = getHoldings()
    .filter(h => /^\d{4}-\d{2}-\d{2}$/.test(h.earningsDate || ''))
    .map(h => ({
      id: h.id, person: h.person, ticker: h.ticker, name: h.name || '', earningsDate: h.earningsDate,
      daysUntil: Math.round((new Date(h.earningsDate + 'T00:00:00+09:00') - today) / 86400000),
    }))
    .sort((a, b) => a.earningsDate.localeCompare(b.earningsDate));
  res.json(list);
});

// 決算日の自動取得 (Yahoo Finance calendarEvents)
// quoteSummary API は認証(cookie+crumb)必須になったため、先に取得してから叩く。
// cookie/crumb は数時間有効なのでキャッシュし、Unauthorized なら取り直して1回だけ再試行。
let _yhAuth = null; // { cookie, crumb, fetchedAt }
const YH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
async function getYahooAuth(force) {
  if (!force && _yhAuth && Date.now() - _yhAuth.fetchedAt < 30 * 60 * 1000) return _yhAuth;
  const r1 = await fetch('https://login.yahoo.com/', {
    headers: { 'User-Agent': YH_UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'manual',
  });
  let cookie = '';
  const allCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''];
  for (const sc of allCookies) {
    const part = sc.split(';')[0];
    if (part) cookie += (cookie ? '; ' : '') + part;
  }
  if (!cookie) {
    const r1b = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': YH_UA }, redirect: 'manual' });
    const sc = r1b.headers.get('set-cookie') || '';
    cookie = sc.split(';')[0];
  }
  if (!cookie) throw new Error('Yahoo cookie取得失敗');
  const crumbText = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': YH_UA, 'Cookie': cookie },
  }).then(r => r.text());
  let crumb = crumbText.trim();
  if (crumb === 'Too Many Requests' || !crumb || crumb.length > 30 || crumb.includes('<')) {
    const crumbText2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YH_UA, 'Cookie': cookie },
    }).then(r => r.text());
    crumb = crumbText2.trim();
  }
  if (!crumb || crumb.length > 30 || crumb.includes('<') || crumb === 'Too Many Requests') throw new Error('Yahoo crumb取得失敗: ' + crumb?.slice(0, 50));
  _yhAuth = { cookie, crumb, fetchedAt: Date.now() };
  return _yhAuth;
}
async function fetchCalendarEvents(ticker, force) {
  const { cookie, crumb } = await getYahooAuth(force);
  return fetch(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`,
    { headers: { 'User-Agent': YH_UA, 'Cookie': cookie } }
  ).then(r => r.json());
}
app.get('/api/earnings-date', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker必要' });
  try {
    let j = await fetchCalendarEvents(ticker, false);
    if (j.finance?.error?.code === 'Unauthorized' || j.quoteSummary?.error?.code === 'Unauthorized') {
      j = await fetchCalendarEvents(ticker, true); // crumb失効 → 取り直して再試行
    }
    const dates = j.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
    if (!dates?.length) return res.status(404).json({ error: '決算日データが見つかりませんでした' });
    const nowSec = Date.now() / 1000;
    const next = dates.find(d => d.raw > nowSec) || dates[dates.length - 1];
    res.json({ earningsDate: next.fmt });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 保有銘柄のAI分析: チャートの形を判定し、利確/損切の目安価格を提案
app.get('/api/stock-analysis', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが設定されていません' });
  const h = getHoldings().find(x => x.id === req.query.id);
  if (!h) return res.status(404).json({ error: '保有銘柄が見つかりません' });
  const symbol = h.ticker;
  const cur = symbol.endsWith('.T') ? 'JPY' : 'USD';
  const cs = cur === 'JPY' ? '¥' : '$';
  let r0;
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`, { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
    r0 = j.chart?.result?.[0];
  } catch {}
  if (!r0) return res.status(502).json({ error: '株価データを取得できませんでした' });
  const q = r0.indicators?.quote?.[0] || {};
  const closes = (q.close || []).filter(v => v != null);
  const highs = (q.high || []).filter(v => v != null);
  const lows = (q.low || []).filter(v => v != null);
  if (closes.length < 30) return res.status(400).json({ error: 'チャートデータが不足しています' });
  const price = r0.meta?.regularMarketPrice ?? closes[closes.length - 1];
  const round = (n) => cur === 'JPY' ? Math.round(n) : Math.round(n * 100) / 100;
  const ma = (n) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
  const ma25 = ma(25), ma75 = ma(75), ma200 = ma(200);
  const rsi = rsiCalc(closes, 14);
  const high52 = Math.max(...closes), low52 = Math.min(...closes);
  const recent = closes.slice(-60);
  const recentHigh = Math.max(...recent), recentLow = Math.min(...recent);
  let atr = null;
  if (highs.length === closes.length && lows.length === closes.length) {
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      if (Number.isFinite(tr)) trs.push(tr);
    }
    if (trs.length >= 14) atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
  }
  const chg = (n) => closes.length > n ? (price - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n] * 100 : null;
  const step = Math.max(1, Math.floor(closes.length / 40));
  const series = closes.filter((_, i) => i % step === 0).map(v => round(v));
  const f = (n) => n == null ? '不明' : `${cs}${round(n).toLocaleString()}`;
  const summary = `銘柄: ${h.name || symbol} (${symbol}) 通貨:${cur}
現在値: ${f(price)}
取得平均(あなたの買値): ${f(h.cost)}
25日移動平均: ${f(ma25)} / 75日: ${f(ma75)} / 200日: ${f(ma200)}
RSI(14): ${rsi != null ? Math.round(rsi) : '不明'}
52週高値: ${f(high52)} / 52週安値: ${f(low52)}
直近60日高値: ${f(recentHigh)} / 直近60日安値: ${f(recentLow)}
ATR(14・1日の変動幅の目安): ${f(atr)}
騰落率: 5日 ${chg(5) != null ? chg(5).toFixed(1) : '?'}% / 20日 ${chg(20) != null ? chg(20).toFixed(1) : '?'}% / 60日 ${chg(60) != null ? chg(60).toFixed(1) : '?'}%
終値の推移(古い→新しい): ${series.join(', ')}`;
  const prompt = `あなたは株式テクニカル分析のアシスタントです。以下の保有銘柄データから、(1)チャートの形・トレンドの判断 (2)利確の目安価格 (3)損切の目安価格 を示してください。
利確は現在値より上、損切は現在値より下の現実的な水準にし、移動平均・直近高安値・ATR・サポート/レジスタンスを根拠にすること。
出力は次のJSONだけ（前後に文章やコードブロックを付けない）:
{"chartShape":"チャートの形とトレンドの説明を日本語で2〜3文","takeProfit":数値,"stopLoss":数値,"tpReason":"利確水準にした理由を日本語1文","slReason":"損切水準にした理由を日本語1文","comment":"一言アドバイスを日本語1文"}
価格(takeProfit/stopLoss)は${cur === 'JPY' ? '整数' : '小数1〜2桁'}の数値のみ。

データ:
${summary}`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error?.message || `API error ${response.status}`); }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';
    let parsed = null;
    try { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch {}
    res.json({
      chartShape: parsed?.chartShape ?? text,
      takeProfit: Number.isFinite(Number(parsed?.takeProfit)) ? round(Number(parsed.takeProfit)) : null,
      stopLoss: Number.isFinite(Number(parsed?.stopLoss)) ? round(Number(parsed.stopLoss)) : null,
      tpReason: parsed?.tpReason ?? '', slReason: parsed?.slReason ?? '', comment: parsed?.comment ?? '',
      currency: cur, price: round(price),
      levels: { ma25: ma25 != null ? round(ma25) : null, ma75: ma75 != null ? round(ma75) : null, high52: round(high52), low52: round(low52), recentHigh: round(recentHigh), recentLow: round(recentLow), rsi: rsi != null ? Math.round(rsi) : null },
    });
  } catch (e) {
    console.error('[stock-analysis]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 目標株価（損切・利確）の設定
app.post('/api/holding/targets', async (req, res) => {
  const { id, takeProfit, stopLoss, earningsDate } = req.body;
  if (!id) return res.status(400).json({ error: 'id が必要です' });
  const ok = await setHoldingTargets(id, { takeProfit, stopLoss, earningsDate });
  if (!ok) return res.status(404).json({ error: '保有銘柄が見つかりません' });
  res.json({ success: true });
});

// 株アラート: 全保有株の現在値を取得し、(1)利確/損切ライン到達 (2)急騰/急落(前日比±5%) (3)決算が近い を push 通知
const MOVE_ALERT_PCT = 5;
app.get('/api/check-price-targets', async (_req, res) => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.json({ sent: 0, reason: 'no vapid' });
  const all = getHoldings();
  if (!all.length) return res.json({ sent: 0, reason: 'no holdings' });
  const subs = getPushSubscriptions();
  if (!subs.length) return res.json({ sent: 0, reason: 'no subscribers' });
  const jstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const notify = (obj) => { const payload = JSON.stringify(obj); for (const sub of subs) webpush.sendNotification(sub, payload).catch(() => {}); };
  const tickers = [...new Set(all.map(h => h.ticker))];
  // 現在値＋前日終値を取得
  const data = {};
  for (const symT of tickers) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symT)}?interval=1d&range=5d`, {
        headers: { 'User-Agent': YH_UA },
      }).then(r => r.json());
      const meta = j.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice != null) {
        // previousClose=前営業日終値（chartPreviousCloseはレンジ起点なので急騰誤検知の元。使わない）
        data[symT] = { price: meta.regularMarketPrice, prevClose: meta.previousClose ?? meta.regularMarketPreviousClose ?? null };
      }
    } catch { /* skip */ }
  }
  let sent = 0;
  const fired = [];
  for (const h of all) {
    const d = data[h.ticker];
    if (!d) continue;
    const p = d.price;
    const cur = h.ticker.endsWith('.T') ? 'JPY' : 'USD';
    const sym = cur === 'JPY' ? '¥' : '$';
    const fmt = (n) => cur === 'JPY' ? Math.round(n).toLocaleString() : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const fmtTk = (h.name && h.name.trim()) ? `${h.name.trim()}（${h.ticker}）` : h.ticker;
    const personName = h.person === 'hers' ? 'ちか' : 'ひろ';
    const flags = h.targetsFired || {};
    // (1) 利確 / 損切
    if (h.takeProfit && p >= h.takeProfit && !flags.tp) {
      notify({ title: '★ 利確ライン到達', body: `${personName}の${fmtTk} が ${sym}${fmt(p)} (目標 ${sym}${fmt(h.takeProfit)})` });
      await markHoldingTargetFired(h.id, 'tp'); sent++; fired.push({ ticker: h.ticker, kind: 'tp' });
    }
    if (h.stopLoss && p <= h.stopLoss && !flags.sl) {
      notify({ title: '▼ 損切ライン到達', body: `${personName}の${fmtTk} が ${sym}${fmt(p)} (目標 ${sym}${fmt(h.stopLoss)})` });
      await markHoldingTargetFired(h.id, 'sl'); sent++; fired.push({ ticker: h.ticker, kind: 'sl' });
    }
    // (2) 急騰 / 急落（前日比 ±MOVE_ALERT_PCT%。同日同方向は1回だけ）
    if (d.prevClose && d.prevClose > 0) {
      const chg = (p - d.prevClose) / d.prevClose * 100;
      if (Math.abs(chg) >= MOVE_ALERT_PCT) {
        const dir = chg >= 0 ? 'up' : 'down';
        const key = `${jstDate}:${h.ticker}:${dir}`;
        if (!hasMoveAlert(key)) {
          notify({ title: dir === 'up' ? '📈 急騰' : '📉 急落', body: `${personName}の${fmtTk} が前日比 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% (${sym}${fmt(p)})` });
          await markMoveAlert(key, jstDate); sent++; fired.push({ ticker: h.ticker, kind: 'move', chg: Math.round(chg * 10) / 10 });
        }
      }
    }
    // (3) 決算が近い（当日 or 翌日。1日1回）
    if (h.earningsDate && h.earningsNotified !== jstDate) {
      const days = Math.round((new Date(h.earningsDate + 'T00:00:00+09:00') - new Date(jstDate + 'T00:00:00+09:00')) / 86400000);
      if (days >= 0 && days <= 1) {
        notify({ title: '📅 決算が近い', body: `${personName}の${fmtTk} の決算は${days === 0 ? '今日' : '明日'}（${h.earningsDate}）` });
        await markHoldingEarningsNotified(h.id, jstDate); sent++; fired.push({ ticker: h.ticker, kind: 'earnings', days });
      }
    }
  }
  res.json({ sent, fired });
});
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
    const ySym = /^\d{3,5}[A-Z]?$/.test(sym) ? sym + '.T' : sym;
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1wk&range=2y`, {
        headers: { 'User-Agent': YH_UA },
      }).then(r => r.json());
      const r0 = j.chart?.result?.[0];
      const m = r0?.meta;
      if (m && m.regularMarketPrice != null) {
        const closes = (r0.indicators?.quote?.[0]?.close || []).filter(x => x != null);
        const t = techSignal(m.regularMarketPrice, closes);
        // 当日変動（ヒートマップ用）
        const prev = m.chartPreviousClose ?? m.previousClose;
        const change = prev ? m.regularMarketPrice - prev : 0;
        const changePct = prev ? (change / prev) * 100 : 0;
        out[sym] = {
          price: m.regularMarketPrice,
          currency: m.currency || 'JPY',
          name: m.shortName || m.longName || sym,
          signal: t?.signal || null,
          rsi: t?.rsi ?? null,
          change,
          changePct,
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
    const fx = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1d&range=5d', { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
    const p = fx.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p) usdjpy = p;
  } catch { /* default */ }
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const perHolding = [];
  const allDates = new Set();
  for (const h of hold) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.ticker)}?interval=1d&range=1y`, { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
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
  // 日付の和集合を作り、各銘柄は前方補完（取引日が違う銘柄でも誤差なく合算）
  // last は各銘柄の「最初に取得できた値」で初期化（後方補完）することで、
  // 銘柄ごとのデータ開始日のズレによる ¥0→評価額 の巨大ジャンプを防ぐ
  const dates = [...allDates].sort();
  const last = perHolding.map((ph) => {
    const firstKey = Object.keys(ph.m).sort()[0];
    return firstKey ? ph.m[firstKey] : 0;
  });
  const history = [];
  for (const date of dates) {
    let mine = 0, hers = 0;
    perHolding.forEach((ph, idx) => {
      if (ph.m[date] != null) last[idx] = ph.m[date];
      if (ph.person === 'hers') hers += last[idx]; else mine += last[idx];
    });
    history.push({ date, mine: Math.round(mine), hers: Math.round(hers) });
  }
  res.json({ history, usdjpy: Math.round(usdjpy * 100) / 100 });
});

// ── 個別銘柄の値動き（チャート用）──
app.get('/api/stock-history', async (req, res) => {
  const sym0 = String(req.query.symbol || '').trim();
  const sym = /^\d{3,5}[A-Z]?$/.test(sym0) ? sym0 + '.T' : sym0;
  if (!sym) return res.status(400).json({ error: 'symbol が必要です' });
  const range = ['1mo', '6mo', '1y', '5y'].includes(req.query.range) ? req.query.range : '6mo';
  const interval = (range === '1y' || range === '5y') ? '1wk' : '1d';
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, {
      headers: { 'User-Agent': YH_UA },
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
      headers: { 'User-Agent': YH_UA },
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

// ── 目標トラッカー ──
app.get('/api/goals', (_req, res) => res.json(getGoals()));
app.post('/api/goals', async (req, res) => {
  const { title, amount, deadline, person } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: '目標名が必要です' });
  if (!(Number(amount) > 0)) return res.status(400).json({ error: '金額が必要です' });
  const goal = await addGoal({ title: String(title).trim(), amount, deadline, person });
  res.json(goal);
});
app.post('/api/goals/delete', async (req, res) => {
  await deleteGoal(req.body.id);
  res.json({ success: true });
});

// ── TARGET PRICES（目標株価メモ）──
app.get('/api/target-prices', (_req, res) => res.json(getTargetPrices()));
app.post('/api/target-prices', async (req, res) => {
  const { ticker, targetPrice, note, person } = req.body;
  if (!ticker || !String(ticker).trim()) return res.status(400).json({ error: 'ティッカーが必要です' });
  if (!(Number(targetPrice) > 0)) return res.status(400).json({ error: '目標株価が必要です' });
  const tp = await addTargetPrice({ ticker, targetPrice, note, person });
  res.json(tp);
});
app.post('/api/target-prices/delete', async (req, res) => {
  await deleteTargetPrice(req.body.id);
  res.json({ success: true });
});

// ── 今月の損益まとめ AI生成 ──
app.post('/api/monthly-summary', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが設定されていません' });
  const { ym, hiroPnl, chikaPnl, trades, topGains, topLosses } = req.body;
  const lines = (trades || []).map(t => {
    const who = t.person === 'hers' ? 'ちか' : 'ひろ';
    const d = new Date(t.ts || 0);
    const ds = `${d.getMonth()+1}/${d.getDate()}`;
    if (t.type === 'buy') return `${ds} ${who} 買 ${t.name||t.ticker} ${t.shares}株 @${t.price}`;
    return `${ds} ${who} 売 ${t.name||t.ticker} 実現${t.realized >= 0 ? '+' : ''}¥${Math.round(t.realized||0).toLocaleString()}`;
  }).join('\n');
  const topG = (topGains||[]).map(h => `${h.name||h.ticker} +${h.pct}%`).join('、');
  const topL = (topLosses||[]).map(h => `${h.name||h.ticker} ${h.pct}%`).join('、');
  const prompt = `あなたはカップルの株投資日記ライターです。以下のデータを元に、今月（${ym}）の投資まとめを日記風に150〜200字で書いてください。
ひろの損益合計: ${hiroPnl >= 0 ? '+' : ''}¥${Math.round(hiroPnl||0).toLocaleString()}
ちかの損益合計: ${chikaPnl >= 0 ? '+' : ''}¥${Math.round(chikaPnl||0).toLocaleString()}
今月の売買:
${lines || 'なし'}
${topG ? `含み益トップ: ${topG}` : ''}
${topL ? `含み損トップ: ${topL}` : ''}

・2人を名前で呼んで、親しみやすく
・数字は具体的に
・良かった点・反省点を1つずつ
・最後にひと言励ましで締める
・絵文字OK`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e.error?.message || `API ${response.status}`); }
    const data = await response.json();
    res.json({ text: data.content?.[0]?.text?.trim() || '' });
  } catch (e) {
    console.error('[monthly-summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MEMOS（ひろ/ちかそれぞれの個人メモ）──
app.get('/api/memos', (_req, res) => res.json(getMemos()));
app.post('/api/memo', async (req, res) => {
  const { person, text, img } = req.body;
  if (!['mine', 'hers'].includes(person)) {
    return res.status(400).json({ error: 'person が不正です' });
  }
  if (!text?.trim() && !img) {
    return res.status(400).json({ error: '内容が必要です' });
  }
  // テキストは必ず保存（画像なし）
  const id = await addMemo({ person, text: text || '' });
  // 画像は別途試みる。失敗しても本文メモは残す
  if (img) {
    try {
      await setMemoImage(id, img);
    } catch (e) {
      console.error('[memo/img] 保存失敗:', e.message);
      return res.json({ success: true, id, imgError: 'ストレージ容量が不足しているため画像を保存できませんでした' });
    }
  }
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
app.post('/api/memo/pin', async (req, res) => {
  const { id, pinned } = req.body;
  if (!id) return res.status(400).json({ error: 'id が必要です' });
  const ok = await pinMemo(id, pinned);
  if (!ok) return res.status(404).json({ error: 'メモが見つかりません' });
  res.json({ success: true });
});

// メモ画像の追加・更新・削除
app.post('/api/memo/image', async (req, res) => {
  const { id, img } = req.body;
  if (!id) return res.status(400).json({ error: 'id が必要です' });
  try {
    const ok = await setMemoImage(id, img || null);
    if (!ok) return res.status(404).json({ error: 'メモが見つかりません' });
    res.json({ success: true });
  } catch (e) {
    console.error('[memo/image] 保存失敗:', e.message);
    res.status(507).json({ error: 'ストレージ容量が不足しているため画像を保存できませんでした' });
  }
});

// カレンダー日別写真（複数枚対応）
app.get('/api/day-photos', (_req, res) => res.json(getPhotos()));
app.post('/api/day-photo', async (req, res) => {
  const { date, person, img } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) が必要です' });
  if (!img) return res.status(400).json({ error: 'img が必要です' });
  try {
    const id = await addPhoto(date, person || null, img);
    res.json({ success: true, id });
  } catch (e) {
    console.error('[day-photo] 保存失敗:', e.message);
    res.status(507).json({ error: 'ストレージ容量が不足しているため写真を保存できませんでした' });
  }
});
app.post('/api/day-photo/delete', async (req, res) => {
  const { date, id } = req.body;
  if (!date || !id) return res.status(400).json({ error: 'date と id が必要です' });
  await deletePhoto(date, id);
  res.json({ success: true });
});

// ── 日記 ──
app.get('/api/diaries', (_req, res) => res.json(getDiaries()));
app.post('/api/diary/delete', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date が必要です' });
  await setDiary(date, null);
  res.json({ success: true });
});
// 日記テキスト保存（person 別）。raw=原文、text=まとめ済み（写真位置の編集を保存する用）
app.post('/api/diary/save', async (req, res) => {
  const { date, person, raw, text } = req.body;
  if (!date || !['mine','hers'].includes(person)) return res.status(400).json({ error: 'date と person が必要です' });
  const existing = getDiary(date) || {};
  const pExisting = existing[person] || {};
  const updated = { ...pExisting };
  if (raw !== undefined) { updated.raw = raw || ''; updated.savedAt = Date.now(); }
  if (text !== undefined) { updated.text = text; updated.generatedAt = pExisting.generatedAt || Date.now(); }
  await setDiary(date, { ...existing, [person]: updated });
  res.json({ success: true });
});

// AI日記まとめ（person別、note.com投稿形式）
app.post('/api/diary/generate', async (req, res) => {
  const { date, person, raw, photoCount } = req.body;
  if (!date || !['mine','hers'].includes(person) || !raw)
    return res.status(400).json({ error: 'date, person, raw が必要です' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが設定されていません' });
  try {
    const personName = person === 'mine' ? 'ひろ' : 'ちか';
    const [, mo, da] = date.split('-');
    const photoHint = Number(photoCount) > 0
      ? `\n・写真が${photoCount}枚ある。文章の自然な区切りに「【写真①】」「【写真②】」…を独立した行で入れて位置を示す（実際の枚数だけ。あとで本人が動かせるので、まずは流れに合う所でよい）。`
      : '';
    const prompt = `${personName}が書いた${mo}月${da}日の日記の原文です。有名な売れっ子ライターが書き直したように、読んで心地よく引き込まれる文章に仕上げてください。

【文体・口調】
・原文の口調をそのまま受け継ぐ。タメ口ならタメ口、丁寧語なら丁寧語。勝手に変えない。
・有名ライターが書いたように、情景や気持ちが目に浮かぶ、読んで気持ちいい文章にする。
・AIっぽい決まり文句（「〜な一日でした」「素敵な時間を」「充実した」「改めて」など）は絶対に使わない。
・原文にない出来事・感情は足さない。

【内容】
・原文の出来事や気持ちは省かず丁寧に盛り込む。短くまとめすぎない。
・誤字や前後した内容を整え、読みやすい自然な流れにする。
・時間（朝・昼・夜や「9時」など）が書かれていれば時系列に沿って並べる。
・本人の言葉や印象的なひとことは積極的に活かす。
・朝・昼・夜や場面が変わるとき（外出→帰宅など）は「## 見出し」で区切る。この見出しがnoteの目次項目になるため、短く具体的な言葉にする（例: ## 夜ごはんのあと）。1場面だけの短い日は不要。
・箇条書きは使わず地の文で。${photoHint}

【出力形式 — 必ず守ること】
・1行目は必ず「# 」（半角シャープ＋半角スペース）で始まる短いタイトルにする。例: # 今日は海へ
・2行目は空行、3行目以降に本文。
・マークダウン記法（**太字**など）は使わない。

原文:
${raw}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      throw new Error(e.error?.message || `API error ${response.status}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';
    const existing = getDiary(date) || {};
    await setDiary(date, { ...existing, [person]: { ...(existing[person]||{}), text, generatedAt: Date.now() } });
    res.json({ success: true, text });
  } catch (e) {
    console.error('[diary/generate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 日記の英訳
app.post('/api/diary/translate', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date が必要です' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが設定されていません' });
  const existing = getDiary(date) || {};
  const rawHers = existing.hers?.raw || '';
  const rawMine = existing.mine?.raw || '';
  if (!rawHers && !rawMine) return res.status(400).json({ error: 'この日には日記がありません' });
  try {
    const parts = [];
    if (rawHers) parts.push(`[Chika]\n${rawHers}`);
    if (rawMine) parts.push(`[Hiro]\n${rawMine}`);
    const prompt = `Translate the following Japanese diary entries into natural, warm English suitable for a personal journal / novel excerpt. Keep the same tone (casual if casual, polite if polite). Preserve the [Chika] and [Hiro] labels exactly. Do NOT add any extra commentary — output ONLY the translation.

${parts.join('\n\n')}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      throw new Error(e.error?.message || `API error ${response.status}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';
    // [Chika] ... [Hiro] ... のパートに分割
    let en_hers = '', en_mine = '';
    const parts2 = text.split(/\n?\[(Chika|Hiro)\]\n?/);
    // parts2 = ['', 'Chika', '...text...', 'Hiro', '...text...']
    for (let i = 1; i < parts2.length; i += 2) {
      const who = parts2[i], body = (parts2[i+1] || '').trim();
      if (who === 'Chika') en_hers = body;
      else if (who === 'Hiro') en_mine = body;
    }
    if (!en_hers && !en_mine) {
      // フォールバック: 全文を hers/mine のあった側に
      if (rawHers && !rawMine) en_hers = text;
      else if (!rawHers && rawMine) en_mine = text;
      else en_hers = text;
    }
    const merged = {
      ...existing,
      translated: {
        en_hers,
        en_mine,
        generatedAt: Date.now(),
      },
    };
    await setDiary(date, merged);
    res.json({ success: true, en_hers, en_mine });
  } catch (e) {
    console.error('[diary/translate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 月間まとめ
// 銘柄の期間チャート (取引日周辺のミニチャート用)
app.get('/api/chart-history', async (req, res) => {
  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    // from/to (ms) が指定なければ 3ヶ月分
    const now = Date.now();
    const toTs = to ? Math.floor(Number(to)/1000) : Math.floor(now/1000);
    const fromTs = from ? Math.floor(Number(from)/1000) : Math.floor((now - 90*24*3600*1000)/1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${fromTs}&period2=${toTs}&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': YH_UA } });
    if (!r.ok) return res.status(r.status).json({ error: 'yahoo error' });
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'no data' });
    const closes = result.indicators?.quote?.[0]?.close || [];
    const timestamps = result.timestamp || [];
    const data = timestamps
      .map((t, i) => ({ t: t*1000, c: closes[i] }))
      .filter(d => d.c != null);
    res.json({ symbol, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trade-analysis', async (req, res) => {
  const { symbol, tradeTs, tradePrice, tradeType } = req.query;
  if (!symbol || !tradeTs || !tradePrice) return res.status(400).json({ error: 'params required' });
  const ts = Number(tradeTs);
  const price = Number(tradePrice);
  const isBuy = tradeType !== 'sell';
  const sym = /^\d{3,5}[A-Z]?$/.test(symbol) ? symbol + '.T' : symbol;
  try {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = Math.floor((ts - 180 * 24 * 3600 * 1000) / 1000);
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${fromSec}&period2=${toSec}&interval=1d`, {
      headers: { 'User-Agent': YH_UA }
    }).then(r => r.json());
    const r0 = j.chart?.result?.[0];
    if (!r0) return res.json({ error: 'no data' });
    const timestamps = r0.timestamp || [];
    const q = r0.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const tradeSec = Math.floor(ts / 1000);
    let tradeIdx = 0;
    let bestDiff = Infinity;
    timestamps.forEach((t, i) => { const d = Math.abs(t - tradeSec); if (d < bestDiff) { bestDiff = d; tradeIdx = i; } });
    const beforeCloses = closes.slice(0, tradeIdx + 1).filter(x => x != null);
    const ma13 = smaCalc(beforeCloses, 13);
    const ma26 = smaCalc(beforeCloses, 26);
    const rsi = rsiCalc(beforeCloses, 14);
    const atrPeriod = 14;
    let atr = null;
    if (tradeIdx >= atrPeriod) {
      let sum = 0;
      for (let i = tradeIdx - atrPeriod + 1; i <= tradeIdx; i++) {
        const h = highs[i], l = lows[i], pc = closes[i - 1];
        if (h != null && l != null && pc != null) sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      atr = sum / atrPeriod;
    }
    let takeProfit = null, stopLoss = null;
    if (atr != null) {
      if (isBuy) { takeProfit = price + atr * 3; stopLoss = price - atr * 1.5; }
      else { takeProfit = price - atr * 3; stopLoss = price + atr * 1.5; }
    }
    const trend = ma13 != null && ma26 != null ? (ma13 > ma26 ? 'up' : 'down') : null;
    const aboveMa = ma13 != null ? price >= ma13 : null;
    let judgment = 'neutral';
    if (isBuy) {
      if (trend === 'up' && aboveMa && rsi != null && rsi < 70) judgment = 'good';
      else if (trend === 'down' && !aboveMa) judgment = 'bad';
      else if (rsi != null && rsi >= 70) judgment = 'bad';
      else if (rsi != null && rsi <= 30) judgment = 'good';
    } else {
      if (trend === 'down' && !aboveMa) judgment = 'good';
      else if (trend === 'up' && aboveMa && rsi != null && rsi < 70) judgment = 'bad';
      else if (rsi != null && rsi >= 70) judgment = 'good';
      else if (rsi != null && rsi <= 30) judgment = 'bad';
    }
    const currentPrice = closes.filter(x => x != null).pop() || null;
    let hindsight = null;
    if (currentPrice != null) {
      const diff = currentPrice - price;
      if (isBuy) hindsight = diff >= 0 ? 'correct' : 'wrong';
      else hindsight = diff <= 0 ? 'correct' : 'wrong';
    }
    res.json({
      ma13: ma13 ? Math.round(ma13 * 100) / 100 : null,
      ma26: ma26 ? Math.round(ma26 * 100) / 100 : null,
      rsi: rsi != null ? Math.round(rsi) : null,
      trend, judgment, takeProfit: takeProfit ? Math.round(takeProfit * 100) / 100 : null,
      stopLoss: stopLoss ? Math.round(stopLoss * 100) / 100 : null,
      currentPrice, hindsight,
      priceDiff: currentPrice != null ? Math.round((currentPrice - price) * 100) / 100 : null,
      priceDiffPct: currentPrice != null ? Math.round((currentPrice - price) / price * 10000) / 100 : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 保有株の「買い増しゾーン」判定 ──
// 各保有銘柄について週足MA13/MA26/RSIをチェックし、押し目買いに適したゾーンかを返す
// Yahooへの問い合わせは並列化（保有20銘柄でも数秒で完了）
app.get('/api/buy-zones', async (_req, res) => {
  const holdings = getHoldings();
  const results = await Promise.all(holdings.map(async (h) => {
    try {
      const sym = h.ticker;
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1wk&range=2y`, {
        headers: { 'User-Agent': YH_UA },
      }).then(r => r.json());
      const r0 = j.chart?.result?.[0];
      if (!r0) return null;
      const closes = (r0.indicators?.quote?.[0]?.close || []).filter(x => x != null);
      const price = r0.meta?.regularMarketPrice;
      if (!price || closes.length < 26) return null;
      const ma13 = smaCalc(closes, 13);
      const ma26 = smaCalc(closes, 26);
      const rsi = rsiCalc(closes, 14);
      if (ma13 == null || ma26 == null || rsi == null) return null;
      const uptrend = ma13 > ma26;
      const nearMa13 = price <= ma13 * 1.03 && price >= ma13 * 0.97;
      const nearMa26 = price <= ma26 * 1.03 && price >= ma26 * 0.97;
      const oversold = rsi <= 35;
      let zone = null;
      let reason = null;
      if (uptrend && nearMa13 && rsi < 60) { zone = 'good'; reason = '上昇トレンド中でMA13(押し目)まで下げてきた'; }
      else if (uptrend && nearMa26 && rsi < 55) { zone = 'good'; reason = '上昇トレンド中でMA26(強い押し目)まで下げた'; }
      else if (oversold && uptrend) { zone = 'good'; reason = 'RSI30台の売られすぎ+上昇トレンドは反発期待'; }
      else if (oversold && !uptrend) { zone = 'caution'; reason = '売られすぎだが下降トレンド中。反発は短期的な可能性'; }
      if (!zone) return null;
      return {
        id: h.id, person: h.person, ticker: h.ticker, name: h.name || '',
        price, ma13: Math.round(ma13 * 100) / 100, ma26: Math.round(ma26 * 100) / 100,
        rsi: Math.round(rsi), trend: uptrend ? 'up' : 'down',
        zone, reason,
        diffFromMa13Pct: Math.round((price - ma13) / ma13 * 10000) / 100,
      };
    } catch { return null; }
  }));
  res.json({ zones: results.filter(Boolean) });
});

// ── 年末損益レポート ──
// 指定年の売買・実現損益を集計し、AIによる振り返り文を添える
app.get('/api/year-review', async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const person = ['mine', 'hers'].includes(req.query.person) ? req.query.person : null;
  const yStart = new Date(year, 0, 1).getTime();
  const yEnd = new Date(year + 1, 0, 1).getTime();
  // 保有日数の計算に前年以前の買いも参照するため、buysは年フィルタしない
  let allBuys = getBuys();
  let sells = getRealized().filter(s => s.ts >= yStart && s.ts < yEnd);
  let buysThisYear = allBuys.filter(b => b.ts >= yStart && b.ts < yEnd);
  if (person) {
    allBuys = allBuys.filter(b => b.person === person);
    sells = sells.filter(s => s.person === person);
    buysThisYear = buysThisYear.filter(b => b.person === person);
  }
  const byCur = { JPY: 0, USD: 0 };
  // 通貨混合を避けるため ticker + currency 複合キーで集計
  const perTickerCur = {};
  let wins = 0, losses = 0;
  for (const s of sells) {
    const cur = s.currency || 'JPY';
    byCur[cur] = (byCur[cur] || 0) + (s.realized || 0);
    const key = `${s.ticker}|${cur}`;
    perTickerCur[key] ||= { ticker: s.ticker, name: s.name || '', realized: 0, currency: cur };
    perTickerCur[key].realized += s.realized || 0;
    if ((s.realized || 0) >= 0) wins++; else losses++;
  }
  // ベスト/ワーストは通貨別に集計してから統合（順位比較は通貨をまたがない）
  const byCurTickers = { JPY: [], USD: [] };
  for (const t of Object.values(perTickerCur)) {
    (byCurTickers[t.currency] || byCurTickers.JPY).push(t);
  }
  const bestPerCur = { JPY: [], USD: [] };
  const worstPerCur = { JPY: [], USD: [] };
  for (const cur of ['JPY', 'USD']) {
    const sorted = byCurTickers[cur].slice().sort((a, b) => b.realized - a.realized);
    bestPerCur[cur] = sorted.filter(t => t.realized > 0).slice(0, 3);
    worstPerCur[cur] = sorted.filter(t => t.realized < 0).slice(-3).reverse();
  }
  const best = [...bestPerCur.JPY, ...bestPerCur.USD];
  const worst = [...worstPerCur.JPY, ...worstPerCur.USD];
  // 保有日数: 前年以前の買いも探索対象に含める（cross-year hold対応）
  const holdingDays = [];
  for (const s of sells) {
    const b = allBuys.find(x => x.person === s.person && x.ticker === s.ticker && x.ts <= s.ts);
    if (b) holdingDays.push(Math.round((s.ts - b.ts) / (24 * 3600 * 1000)));
  }
  const totalWinLoss = wins + losses;
  const winRate = totalWinLoss ? Math.round(wins / totalWinLoss * 100) : null;
  const avgHold = holdingDays.length ? Math.round(holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length) : null;
  const buys = buysThisYear; // AIプロンプトで買い件数を出すため

  let aiSummary = null;
  if (process.env.ANTHROPIC_API_KEY && sells.length > 0) {
    const personLabel = person === 'mine' ? 'ひろ' : person === 'hers' ? 'ちか' : 'ふたり';
    const allTickers = Object.values(perTickerCur).sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
    const lines = allTickers.slice(0, 10).map(t => `- ${t.name || t.ticker}: ${t.realized >= 0 ? '+' : ''}${(t.currency==='USD'?'$':'¥')}${Math.round(t.realized).toLocaleString()}`).join('\n');
    const prompt = `${personLabel}の${year}年の売買記録の総括をお願いします。
売買件数: 買${buys.length}件 / 売${sells.length}件
実現損益: 円 ${Math.round(byCur.JPY).toLocaleString()}円 / ドル ${byCur.USD.toFixed(2)}$
勝敗: ${wins}勝${losses}敗（勝率${winRate}%）
平均保有日数: ${avgHold}日

銘柄別損益:
${lines}

【出力】3〜4文で今年の投資の傾向を優しくまとめてください。
・良かった点1つ
・改善余地1つ
・来年に向けた一言
専門用語なし、励ます口調で。`;
    try {
      const j = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
      }).then(r => r.json());
      aiSummary = j?.content?.[0]?.text?.trim() || null;
    } catch {}
  }

  res.json({
    year, person,
    buyCount: buys.length, sellCount: sells.length,
    realizedJpy: Math.round(byCur.JPY), realizedUsd: Math.round(byCur.USD * 100) / 100,
    wins, losses, winRate, avgHoldingDays: avgHold,
    best, worst,
    aiSummary,
  });
});

app.get('/api/monthly-diaries', (_req, res) => res.json(getMonthlyDiaries()));

// しおり (本のブックマーク)
app.get('/api/bookmarks', (_req, res) => res.json(getBookmarks()));
app.post('/api/bookmarks', async (req, res) => {
  const { key, note, person, colorTop, colorBottom } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key が必要です' });
  await setBookmark(key, { note, person, colorTop, colorBottom });
  res.json({ success: true });
});
app.post('/api/bookmarks/delete', async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key が必要です' });
  await setBookmark(key, null);
  res.json({ success: true });
});
app.post('/api/diary/monthly', async (req, res) => {
  const { yearMonth, person } = req.body;
  if (!yearMonth || !person) return res.status(400).json({ error: 'yearMonth と person が必要です' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが設定されていません' });
  const diaries = getDiaries();
  const entries = [];
  for (const [date, d] of Object.entries(diaries)) {
    if (!date.startsWith(yearMonth)) continue;
    const pData = d[person];
    if (pData?.text || pData?.raw) entries.push({ date, text: pData.text || pData.raw });
  }
  if (!entries.length) {
    const name = person === 'mine' ? 'ひろ' : 'ちか';
    return res.status(400).json({ error: `${yearMonth}の${name}の日記がありません` });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const [y, m] = yearMonth.split('-');
  const personName = person === 'mine' ? 'ひろ' : 'ちか';
  const prompt = `以下は${y}年${m}月の${personName}の日記（日付ごと）です。これを1ヶ月の振り返りとして、コンパクトに、心に残るようにまとめてください。

【最優先】
・日ごとの寄せ集めにしない。日付を並べて要約するのではなく、1ヶ月を通したひと続きの文章にする。
・印象的だった出来事・気持ちの変化・繰り返し出てくるテーマを拾って要点を絞る。細かい日常は思い切って省いてよい。
・${personName}の口調をそのまま受け継ぐ（タメ口ならタメ口、丁寧語なら丁寧語）。勝手に「です・ます」調にしない。
・AIっぽい決まり文句や総括・説明口調は使わない。本人が1ヶ月を思い返して書いたように。
・原文に無いことは足さない。

【構成】
・1行目に「# 」で短いタイトル（その月を象徴する一言）。
・月の前半→後半の時系列、または出来事・気持ちのテーマで「## 見出し」を2〜4個。
・各セクションは2〜4行程度。全体で長くなりすぎないように、ぎゅっと。
・箇条書きは使わず地の文で。

${entries.map(e => `【${e.date}】\n${e.text}`).join('\n\n')}`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      throw new Error(e.error?.message || `API error ${response.status}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';
    const existing = getMonthlyDiaries()[yearMonth] || {};
    await setMonthlyDiary(yearMonth, { ...existing, [person]: { text, generatedAt: Date.now() } });
    res.json({ success: true, text });
  } catch (e) {
    console.error('[diary/monthly]', e.message);
    res.status(500).json({ error: e.message });
  }
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

// 写真キャッシュ強制リロード（起動時にRedis接続失敗した場合のリカバリ）
app.post('/api/photos/reload', async (_req, res) => {
  await reloadPhotoCache();
  res.json({ success: true });
});

// ── 株式スクリーニング（日経225） ──
const NIKKEI225 = [
  '1332','1333','1605','1721','1801','1802','1803','1808','1812','1925',
  '1928','1963','2002','2269','2282','2413','2432','2501','2502','2503',
  '2531','2587','2801','2802','2871','2914','3086','3092','3099','3382',
  '3402','3407','3436','3659','3861','3863','4004','4005','4021','4042',
  '4043','4061','4063','4151','4183','4188','4208','4324','4385','4452',
  '4502','4503','4506','4507','4519','4523','4543','4568','4578','4661',
  '4689','4704','4751','4755','4901','4902','4911','5019','5020','5101',
  '5108','5201','5202','5214','5232','5233','5301','5332','5333','5401',
  '5406','5411','5541','5631','5706','5711','5713','5714','5715','5801',
  '5802','5803','6098','6103','6113','6146','6178','6273','6301','6302',
  '6305','6326','6361','6367','6370','6471','6472','6473','6479','6501',
  '6503','6504','6506','6526','6645','6674','6701','6702','6703','6706',
  '6723','6724','6752','6753','6758','6762','6770','6841','6902','6920',
  '6952','6954','6971','6976','6981','7003','7004','7011','7012','7013',
  '7186','7201','7202','7203','7205','7211','7261','7267','7269','7270',
  '7272','7731','7733','7735','7741','7751','7752','7762','7832','7911',
  '7912','7974','8001','8002','8015','8031','8035','8053','8058','8233',
  '8252','8253','8267','8306','8308','8309','8316','8331','8354','8355',
  '8411','8473','8591','8601','8604','8628','8630','8697','8750','8766',
  '8795','8801','8802','8804','8830','9001','9005','9007','9008','9009',
  '9020','9021','9022','9064','9101','9104','9107','9202','9301','9432',
  '9433','9434','9531','9532','9602','9613','9735','9766','9983','9984',
];

function emaArr(prices, period) {
  const k = 2 / (period + 1);
  const out = [prices[0]];
  for (let i = 1; i < prices.length; i++) out.push(prices[i] * k + out[i-1] * (1-k));
  return out;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const ch = closes.slice(1).map((v, i) => v - closes[i]);
  let ag = 0, al = 0;
  for (let i = 0; i < period; i++) { ag += Math.max(0, ch[i]); al += Math.max(0, -ch[i]); }
  ag /= period; al /= period;
  for (let i = period; i < ch.length; i++) {
    ag = (ag*(period-1) + Math.max(0, ch[i])) / period;
    al = (al*(period-1) + Math.max(0, -ch[i])) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = emaArr(ml.slice(25), 9);
  return { macd: ml[ml.length-1], signal: sl[sl.length-1], prevMacd: ml[ml.length-2], prevSignal: sl[sl.length-2] };
}
function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const mean = s.reduce((a, v) => a+v, 0) / period;
  const std = Math.sqrt(s.reduce((a, v) => a+(v-mean)**2, 0) / period);
  return { lower: mean - 2*std, price: closes[closes.length-1] };
}
function scoreStock(closes) {
  const signals = [];
  const rsi = calcRSI(closes);
  if (rsi !== null && rsi <= 35) signals.push(`RSI ${rsi.toFixed(0)}`);
  const macd = calcMACD(closes);
  if (macd) {
    if (macd.prevMacd <= macd.prevSignal && macd.macd > macd.signal)
      signals.push('MACDゴールデンクロス');
    else if (macd.macd > macd.signal && macd.macd < 0)
      signals.push('MACD強気転換中');
  }
  const bb = calcBB(closes);
  if (bb && bb.price <= bb.lower) signals.push('BB-2σ以下');
  return { count: signals.length, signals, rsi };
}

let screening = { status: 'idle', date: '', results: [], done: 0, total: NIKKEI225.length };

app.get('/api/screening', (_req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  if (screening.status === 'done' && screening.date === today)
    return res.json({ status: 'done', results: screening.results });
  if (screening.status === 'running')
    return res.json({ status: 'running', done: screening.done, total: screening.total });
  screening = { status: 'running', date: today, results: [], done: 0, total: NIKKEI225.length };
  runScreening(today);
  res.json({ status: 'running', done: 0, total: NIKKEI225.length });
});

app.post('/api/screening/refresh', (_req, res) => {
  if (screening.status === 'running') return res.json({ status: 'running' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  screening = { status: 'running', date: today, results: [], done: 0, total: NIKKEI225.length };
  runScreening(today);
  res.json({ status: 'running', done: 0, total: NIKKEI225.length });
});

// ── 監視銘柄 API ──
app.get('/api/watchlist', (_req, res) => res.json(getWatchlist()));
app.post('/api/watchlist/add', async (req, res) => {
  try {
    const { person, ticker, name } = req.body || {};
    await addWatchStock(person, ticker, name);
    res.json({ success: true, watchlist: getWatchlist() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/watchlist/remove', async (req, res) => {
  const { person, ticker } = req.body || {};
  await removeWatchStock(person, ticker);
  res.json({ success: true, watchlist: getWatchlist() });
});

// ── デモ取引 API ──
app.get('/api/demo-trades', (_req, res) => res.json(getDemoTrades()));
app.post('/api/demo-trades/add', async (req, res) => {
  try {
    const { person, trade } = req.body || {};
    if (!trade || !trade.ticker) throw new Error('取引データが不正です');
    trade.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await addDemoTrade(person || 'mine', trade);
    res.json({ success: true, demoTrades: getDemoTrades() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/demo-trades/remove', async (req, res) => {
  const { person, id } = req.body || {};
  await removeDemoTrade(person || 'mine', id);
  res.json({ success: true, demoTrades: getDemoTrades() });
});

// ── TOPIX Core30 (代表30銘柄、時価総額最上位) ──
const TOPIX_CORE30 = [
  '4063','4502','4519','4568','6098','6501','6758','6861','6902','6981',
  '7203','7267','7741','7974','8001','8031','8035','8053','8058','8306',
  '8316','8411','8766','8801','8802','9432','9433','9983','9984','6367',
];

// ── TOPIX 500相当 (N225 + Prime市場の主要銘柄約280社を追加) ──
// 正確な TOPIX 500 の membership は取引所非公開のため、
// Prime 市場の時価総額上位・出来高多い銘柄を手動でリスト化
const TOPIX_EXTRA = [
  // Prime市場・大型
  '1352','1414','1417','1518','1720','1893','1911','1944','1951','2127',
  '2181','2264','2301','2332','2371','2385','2410','2427','2429','2440',
  '2464','2475','2531','2593','2607','2670','2681','2695','2698','2702',
  '2726','2730','2733','2737','2768','2801','2809','2810','2811','2815',
  '2816','2871','2874','2875','2882','2884','2897','2899','3003','3020',
  '3038','3048','3050','3064','3068','3088','3141','3197','3231','3244',
  '3252','3288','3289','3291','3315','3391','3405','3421','3474','3626',
  '3632','3635','3657','3668','3697','3712','3765','3778','3796','3802',
  '3844','3900','3915','3922','3941','3946','3962','3968','3990','3994',
  '4004','4005','4021','4026','4041','4042','4043','4044','4045','4088',
  '4091','4114','4116','4118','4182','4185','4187','4212','4218','4245',
  '4272','4274','4275','4287','4324','4331','4344','4348','4356','4361',
  '4362','4368','4384','4390','4394','4395','4396','4429','4436','4443',
  '4447','4477','4478','4480','4483','4485','4488','4499','4507','4506',
  '4536','4540','4541','4548','4553','4554','4557','4574','4577','4587',
  '4598','4599','4611','4612','4613','4614','4617','4634','4651','4653',
  '4661','4676','4680','4681','4684','4687','4694','4695','4708','4712',
  '4716','4719','4722','4725','4726','4732','4733','4739','4745','4748',
  '4750','4762','4770','4776','4816','4819','4820','4826','4901','4902',
  '4911','4912','4917','4919','4922','4923','4927','4928','4931','4967',
  '4968','4970','4996','5008','5017','5019','5021','5122','5185','5191',
  '5195','5201','5202','5214','5232','5233','5273','5301','5334','5423',
  '5480','5563','5713','5714','5715','5726','5727','5802','5817','5852',
  '5901','5911','5929','5938','5947','5949','5975','6113','6135','6141',
  '6146','6165','6166','6178','6191','6194','6196','6197','6200','6236',
  '6238','6249','6255','6266','6268','6269','6273','6277','6284','6289',
  '6301','6302','6305','6316','6323','6324','6326','6330','6338','6345',
  '6349','6355','6361','6370','6383','6390','6395','6407','6409','6412',
  '6415','6417','6428','6432','6433','6436','6440','6445','6448','6455',
  '6457','6465','6473','6474','6479','6481','6482','6486','6489','6490',
  '6498','6501','6504','6506','6507','6508','6544','6549','6550','6551',
  '6552','6553','6554','6555','6564','6572','6577','6579','6584','6588',
  '6590','6592','6594','6595','6613','6619','6620','6625','6630','6632',
  '6641','6644','6645','6646','6652','6653','6654','6656','6659','6666',
  '6670','6674','6676','6677','6683','6699','6703','6707','6715','6720',
  '6727','6740','6754','6755','6756','6760','6762','6767','6770','6807',
  '6839','6841','6849','6850','6852','6853','6856','6857','6859','6861',
  '6869','6875','6877','6879','6883','6890','6905','6923','6924','6930',
  '6942','6947','6951','6963','6965','6966','6967','6969','6971','6976',
  '6981','6988','6989','6996','7011','7014','7014','7203','7205','7211',
  '7222','7228','7236','7251','7259','7267','7269','7270','7272','7276',
  '7278','7282','7296','7309','7466','7476','7524','7550','7581','7590',
  '7599','7605','7609','7611','7623','7628','7649','7692','7729','7731',
  '7732','7733','7735','7741','7747','7752','7761','7860','7867','7911',
  '7912','7917','7918','7936','7947','7951','7965','7972','7974','7987',
];

const TOPIX_500 = [...new Set([...NIKKEI225, ...TOPIX_EXTRA])];

function getUniverseCodes(universe) {
  if (universe === 'topix30') return TOPIX_CORE30;
  if (universe === 'topix500') return TOPIX_500;
  if (universe === 'watchlist_mine' || universe === 'watchlist_hers') {
    const key = universe === 'watchlist_mine' ? 'mine' : 'hers';
    return (getWatchlist()[key] || []).map(w => w.ticker.replace(/\.T$/, ''));
  }
  return NIKKEI225;
}

// ── 組み合わせスクリーナー（本の各章のシグナルを N225 に適用） ──
// 銘柄別のインジケーターを universe別・30分キャッシュ、同じデータを全コンボで再利用
let comboCache = {}; // { universe: { ts, data } }
const COMBO_CACHE_TTL = 30 * 60 * 1000;

async function fetchN225Indicators(universe = 'nikkei225') {
  const now = Date.now();
  const cache = comboCache[universe];
  if (cache && cache.data.length && (now - cache.ts) < COMBO_CACHE_TTL) return cache.data;
  const codes = getUniverseCodes(universe);
  if (!codes.length) { comboCache[universe] = { ts: now, data: [] }; return []; }
  const BATCH = 15, out = [];
  for (let i = 0; i < codes.length; i += BATCH) {
    await Promise.all(codes.slice(i, i+BATCH).map(async code => {
      try {
        const sym = `${code}.T`;
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1y`,
          { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(8000) }
        );
        const d = await r.json();
        const r0 = d?.chart?.result?.[0];
        const q = r0?.indicators?.quote?.[0];
        const closes = (q?.close || []).filter(v => v != null);
        const volumes = (q?.volume || []).filter(v => v != null);
        if (closes.length < 60) return;
        const ind = computeComboIndicators(closes, volumes);
        out.push({
          code, symbol: sym,
          name: r0.meta?.shortName || r0.meta?.longName || code,
          price: closes[closes.length-1],
          ...ind,
        });
      } catch {}
    }));
    if (i + BATCH < codes.length) await new Promise(r => setTimeout(r, 200));
  }
  comboCache[universe] = { ts: now, data: out };
  return out;
}

function computeComboIndicators(c, v) {
  const p = c[c.length-1];
  const ma = (n) => c.length < n ? null : c.slice(-n).reduce((a,b)=>a+b,0) / n;
  const ma5 = ma(5), ma13 = ma(13), ma20 = ma(20), ma25 = ma(25), ma75 = ma(75), ma200 = ma(200);
  const ma5Prev = c.length < 6 ? null : c.slice(-6, -1).reduce((a,b)=>a+b,0)/5;
  const ma25Prev = c.length < 26 ? null : c.slice(-26, -1).reduce((a,b)=>a+b,0)/25;
  const rsi = calcRSI(c, 14);
  const rsiPrev = c.length >= 15 ? calcRSI(c.slice(0,-1), 14) : null;
  const macd = calcMACD(c);
  const bb = calcBB(c, 20);
  const std20 = (() => { if (c.length < 20) return null; const s=c.slice(-20); const m=s.reduce((a,b)=>a+b,0)/20; return Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/20); })();
  const bbUpper = ma20 && std20 ? ma20 + 2*std20 : null;
  const bbLower = ma20 && std20 ? ma20 - 2*std20 : null;
  const bbWidth = (bbUpper != null && ma20) ? (bbUpper - bbLower) / ma20 : null;
  // 過去60日で最狭のバンド幅かどうか（Squeeze判定）
  let bbWidthMinInPast60 = null;
  if (c.length >= 80) {
    let mn = Infinity;
    for (let i = -60; i < 0; i++) {
      const idx = c.length + i;
      if (idx < 20) continue;
      const s = c.slice(idx-19, idx+1);
      const m = s.reduce((a,b)=>a+b,0) / 20;
      const sd = Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0) / 20);
      const w = (m + 2*sd - (m - 2*sd)) / m;
      if (w < mn) mn = w;
    }
    bbWidthMinInPast60 = mn;
  }
  // 週足MA (5日足=1週間近似)
  const weekly = [];
  for (let i = c.length - 1; i >= 0; i -= 5) weekly.unshift(c[i]);
  const wma13 = weekly.length >= 13 ? weekly.slice(-13).reduce((a,b)=>a+b,0)/13 : null;
  const wma26 = weekly.length >= 26 ? weekly.slice(-26).reduce((a,b)=>a+b,0)/26 : null;
  const wRsi = calcRSI(weekly, 14);
  // Volume
  const volMa20 = v.length >= 20 ? v.slice(-20).reduce((a,b)=>a+b,0)/20 : null;
  const curVol = v[v.length-1];
  const volRatio = volMa20 ? curVol / volMa20 : null;
  // 20日高値・安値
  const high20 = c.length >= 20 ? Math.max(...c.slice(-20)) : null;
  const low20 = c.length >= 20 ? Math.min(...c.slice(-20)) : null;
  const low40Prev = c.length >= 60 ? Math.min(...c.slice(-60, -20)) : null;
  const low40PrevIdx = (() => {
    if (c.length < 60) return -1;
    const s = c.slice(-60, -20);
    return s.indexOf(Math.min(...s));
  })();
  const rsi20LowAgo = c.length >= 34 ? calcRSI(c.slice(0, c.length - 20 + low40PrevIdx + 1), 14) : null;
  return {
    ma5, ma13, ma20, ma25, ma75, ma200, ma5Prev, ma25Prev, rsi, rsiPrev,
    macd, bb, bbUpper, bbLower, bbWidth, bbWidthMinInPast60,
    wma13, wma26, wRsi, volMa20, curVol, volRatio, high20, low20, low40Prev, rsi20LowAgo,
  };
}

const COMBO_CHECKS = {
  ma_rsi_push: {
    label: '移動平均線と勢い指標で押し目買い', chapter: '第6章',
    desc: '上昇中の株が一時的に下がった「お買い得ポイント」。平均線の近くまで下がり、勢い指標も控えめなので、再び上がる可能性が高い場面。',
    check: (i, p) => i.ma25 && i.wma13 && i.wma26 && i.wma13 > i.wma26 && p >= i.ma25 * 0.97 && p <= i.ma25 * 1.03 && i.rsi != null && i.rsi >= 30 && i.rsi <= 45,
    detail: (i, p) => `週足で上昇トレンド / 株価が25日移動平均線の近く / RSI ${i.rsi ? i.rsi.toFixed(0) : '-'}`,
  },
  ma_macd_bottom: {
    label: '移動平均線と勢い転換で底値反発', chapter: '第7章',
    desc: '下がっていた株の流れが変わり始めた瞬間。平均線が上向きに転じ、勢いの指標もプラスに転換。底打ちして上がり始めるサイン。',
    check: (i, p) => i.ma25 && i.ma25Prev && i.ma25 > i.ma25Prev && i.macd && i.macd.prevMacd <= i.macd.prevSignal && i.macd.macd > i.macd.signal && i.macd.macd > 0,
    detail: (i, p) => `25日移動平均線が上向き転換 / 勢い指標が上抜け / 勢い指標がプラス`,
  },
  perfect_order: {
    label: '三本の移動平均線がきれいに揃った上昇', chapter: '第8章',
    desc: '短期・中期・長期の3つの平均線が全て上向きに並んだ最も強い上昇パターン。勢いが強く、トレンドに乗りやすい局面。',
    check: (i, p) => i.ma5 && i.ma25 && i.ma75 && p > i.ma5 && i.ma5 > i.ma25 && i.ma25 > i.ma75,
    detail: (i, p) => `株価 > 5日 > 25日 > 75日移動平均線（強い上昇トレンド）`,
  },
  volume_ma_break: {
    label: '25日移動平均線を出来高を伴って上抜け', chapter: '第12章',
    desc: '平均的な株価ラインを大量の売買を伴って突破。多くの投資家が注目している証拠で、上昇が本物である可能性が高い。',
    check: (i, p) => i.ma25 && i.ma25Prev && p > i.ma25 && (i.ma25 - i.ma25Prev < i.ma25 * 0.005) === false && i.volRatio != null && i.volRatio >= 1.5,
    detail: (i, p) => `25日移動平均線を上抜け / 出来高が普段の${i.volRatio ? i.volRatio.toFixed(1) : '-'}倍`,
  },
  golden_cross_vol: {
    label: '短期線が長期線を上抜け（出来高付き）', chapter: '第13章',
    desc: '「ゴールデンクロス」と呼ばれる買いサイン。短期の流れが長期を追い越し、さらに売買量が多いので信頼度が高い。',
    check: (i, p) => i.ma5 && i.ma25 && i.ma5Prev && i.ma25Prev && i.ma5Prev <= i.ma25Prev && i.ma5 > i.ma25 && i.volRatio != null && i.volRatio >= 1.5,
    detail: (i, p) => `5日線が25日線を上抜け / 出来高が普段の${i.volRatio ? i.volRatio.toFixed(1) : '-'}倍`,
  },
  rsi_bb_reversal: {
    label: '売られすぎ+バンド下限反発（逆張り）', chapter: '第14章',
    desc: '株が下がりすぎて「安売り状態」に。統計的な下限にも達しているので、反発して上がりやすいタイミング。',
    check: (i, p) => i.bbLower != null && i.rsi != null && p <= i.bbLower && i.rsi <= 30,
    detail: (i, p) => `株価がバンド下限（-2σ）割れ / RSI ${i.rsi ? i.rsi.toFixed(0) : '-'}（売られすぎ）`,
  },
  rsi_divergence: {
    label: '株価と勢いのズレ（強気の底反転）', chapter: '第16章',
    desc: '株価はまだ安いのに、下落の「勢い」は弱まっている。売り手が力尽きつつある証拠で、近く反転上昇する兆候。',
    check: (i, p) => i.low40Prev != null && i.rsi20LowAgo != null && i.rsi != null && p <= i.low40Prev * 1.02 && i.rsi > i.rsi20LowAgo + 5,
    detail: (i, p) => `株価は前回安値付近だが RSIは前回よりも高い（下落の勢いが弱まっている）`,
  },
  pb_rsi_reversal: {
    label: 'バンド割れ+極端な売られすぎ', chapter: '第18章',
    desc: '極端に売られすぎた状態。統計的に「ここまで下がるのは異常」なレベルなので、短期で大きく反発する可能性がある。',
    check: (i, p) => i.bbLower != null && i.bbUpper != null && p < i.bbLower && i.rsi != null && i.rsi < 25,
    detail: (i, p) => `株価がバンド下限突破 / RSI ${i.rsi ? i.rsi.toFixed(0) : '-'}（極端な売られすぎ）`,
  },
  bb_squeeze: {
    label: 'ボリンジャーバンド収束（大変動の前兆）', chapter: '第22章',
    desc: '株価の変動幅が過去最小レベルに縮小。エネルギーが溜まっている状態で、近いうちに大きく動く前触れ。上下どちらかに注目。',
    check: (i, p) => i.bbWidth != null && i.bbWidthMinInPast60 != null && Math.abs(i.bbWidth - i.bbWidthMinInPast60) < 0.005,
    detail: (i, p) => `過去60日で最狭のバンド幅（次に大きな動きが来やすい）`,
  },
  breakout_high20: {
    label: '20日高値を出来高を伴って突破', chapter: '第23章',
    desc: '直近20日間の最高値を大量の売買で突破。新しい上昇ステージに入った可能性が高く、勢いに乗るチャンス。',
    check: (i, p) => i.high20 != null && p >= i.high20 && i.volRatio != null && i.volRatio >= 1.5,
    detail: (i, p) => `20日高値を突破 / 出来高が普段の${i.volRatio ? i.volRatio.toFixed(1) : '-'}倍`,
  },
  weekly_push: {
    label: '週足で長期上昇中の押し目', chapter: '第28章',
    desc: '週単位で見ても上昇トレンドが続いている中での一時的な下げ。長期投資家にとっての買い場で、中長期で利益を狙えるポイント。',
    check: (i, p) => i.wma13 && i.wma26 && i.wma13 > i.wma26 && p >= i.wma13 * 0.97 && p <= i.wma13 * 1.03 && i.wRsi != null && i.wRsi >= 40 && i.wRsi <= 55,
    detail: (i, p) => `週足の13週線 > 26週線（上昇） / 13週線近辺で押し目 / 週足RSI ${i.wRsi ? i.wRsi.toFixed(0) : '-'}`,
  },
  ma200_uptrend: {
    label: '200日線の上での押し目', chapter: '第30章',
    desc: '長期トレンド（200日平均線）は上向きのまま、一時的に下がった場面。長い目で見れば上昇基調なので、割安に買えるチャンス。',
    check: (i, p) => i.ma200 && p > i.ma200 && p <= i.ma200 * 1.05 && i.rsi != null && i.rsi <= 50,
    detail: (i, p) => `株価が200日線より上・近く / RSI ${i.rsi ? i.rsi.toFixed(0) : '-'}（押し目レベル）`,
  },
  overheated_top: {
    label: '買われすぎ・利益確定の目安', chapter: '第33章',
    desc: '株が上がりすぎて「割高」になっている状態。利益確定売りが出やすく、ここからの新規買いはリスクが高い。保有中なら売り時かも。',
    check: (i, p) => i.rsi != null && i.rsi >= 75 && i.bbUpper != null && p >= i.bbUpper,
    detail: (i, p) => `RSI ${i.rsi ? i.rsi.toFixed(0) : '-'} / 株価がバンド上限超え（買われすぎ）`,
  },
  weekly_rsi_bottom: {
    label: '週足で売られすぎ・底値反発', chapter: '第36章',
    desc: '週単位の勢い指標が「売られすぎ」水準。中長期的に見て底値圏にある可能性が高く、反発狙いの買いポイント。',
    check: (i, p) => i.wRsi != null && i.wRsi <= 35,
    detail: (i, p) => `週足RSI ${i.wRsi ? i.wRsi.toFixed(0) : '-'}（売られすぎ水準）`,
  },
};

app.get('/api/screener/combos', (_req, res) => {
  const combos = Object.entries(COMBO_CHECKS).map(([id, c]) => ({
    id, label: c.label, chapter: c.chapter,
  }));
  res.json({ combos });
});

// ── 単一銘柄の全シグナル判定（監視銘柄のチャート/一覧で使う） ──
async function computeStockSignals(code) {
  try {
    const sym = /^\d{3,5}[A-Z]?$/.test(code) ? code + '.T' : code;
    const j = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`,
      { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(6000) }
    ).then(r => r.json());
    const r0 = j?.chart?.result?.[0];
    const q = r0?.indicators?.quote?.[0];
    const closes = (q?.close || []).filter(v => v != null);
    const volumes = (q?.volume || []).filter(v => v != null);
    if (closes.length < 30) return { signals: [] };
    const ind = computeComboIndicators(closes, volumes);
    const p = closes[closes.length - 1];
    const signals = [];
    for (const [id, c] of Object.entries(COMBO_CHECKS)) {
      try { if (c.check(ind, p)) signals.push({ id, label: c.label, chapter: c.chapter, detail: c.detail(ind, p), desc: c.desc || '' }); } catch {}
    }
    return { symbol: sym, price: p, signals };
  } catch (e) { return { signals: [], error: e.message }; }
}

app.get('/api/stock-signals', async (req, res) => {
  const code = String(req.query.symbol || '').trim().replace(/\.T$/, '');
  if (!code) return res.status(400).json({ error: 'symbol が必要です' });
  const r = await computeStockSignals(code);
  res.json(r);
});

// 監視銘柄の全銘柄に対して一括シグナル判定
app.get('/api/watchlist/signals', async (req, res) => {
  const person = ['mine', 'hers'].includes(req.query.person) ? req.query.person : 'mine';
  const list = (getWatchlist()[person] || []).map(w => w.ticker.replace(/\.T$/, ''));
  if (!list.length) return res.json({ results: {} });
  const results = {};
  const BATCH = 8;
  for (let i = 0; i < list.length; i += BATCH) {
    await Promise.all(list.slice(i, i+BATCH).map(async code => {
      const r = await computeStockSignals(code);
      results[code + '.T'] = r.signals;
    }));
    if (i + BATCH < list.length) await new Promise(r => setTimeout(r, 150));
  }
  res.json({ results });
});

// ── ロウソク足データ取得 (OHLC + interval対応) ──
app.get('/api/candle-data', async (req, res) => {
  const code0 = String(req.query.symbol || '').trim();
  const sym = /^\d{3,5}[A-Z]?$/.test(code0) ? code0 + '.T' : code0;
  const interval = ['1d', '1wk', '1mo'].includes(req.query.interval) ? req.query.interval : '1d';
  const range = interval === '1mo' ? '5y' : interval === '1wk' ? '2y' : '6mo';
  try {
    const j = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
      { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(8000) }
    ).then(r => r.json());
    const r0 = j?.chart?.result?.[0];
    if (!r0) throw new Error('データなし');
    const ts = r0.timestamp || [];
    const q = r0.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      bars.push({ t: ts[i], o, h, l, c, v: v || 0 });
    }
    res.json({ symbol: sym, currency: r0.meta?.currency || 'JPY', interval, bars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-scrape', async (req, res) => {
  const code = req.query.symbol || '7203';
  const sym = code.replace(/\.T$/, '');
  try {
    const url = `https://www.google.com/finance/quote/${encodeURIComponent(sym)}:TYO`;
    const html = await fetch(url, {
      headers: { 'User-Agent': YH_UA, 'Accept': 'text/html', 'Accept-Language': 'ja,en' },
      signal: AbortSignal.timeout(10000),
    }).then(r => r.text());
    const findMetric = (label) => {
      const re = new RegExp(label + '[^]*?<div[^>]*>([^<]+)</div>', 'is');
      const m = html.match(re);
      return m ? m[1].trim() : null;
    };
    const metrics = {};
    const re = /<div[^>]*class="[^"]*SwQK7[^"]*"[^>]*>([^<]+)<\/div>\s*<div[^>]*class="[^"]*dO6ijd[^"]*"[^>]*>([^<]+)<\/div>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
      metrics[match[1].trim()] = match[2].trim();
    }
    res.json({
      html_length: html.length,
      title: (html.match(/<title>([^<]*)/i) || [])[1],
      all_metrics: metrics,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-yahoo', async (req, res) => {
  const sym = req.query.symbol || '7203.T';
  const results = {};
  try {
    const { cookie, crumb } = await getYahooAuth(true);
    results.auth = { cookie: cookie ? cookie.slice(0, 20) + '...' : null, crumb };
    const r1 = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail&crumb=${encodeURIComponent(crumb)}`,
      { headers: { 'User-Agent': YH_UA, 'Cookie': cookie }, signal: AbortSignal.timeout(8000) }
    );
    results.q1_status = r1.status;
    results.q1_body = await r1.json();
  } catch (e) { results.q1_error = e.message; }
  try {
    const { cookie, crumb } = await getYahooAuth(false);
    const r2 = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail&crumb=${encodeURIComponent(crumb)}`,
      { headers: { 'User-Agent': YH_UA, 'Cookie': cookie }, signal: AbortSignal.timeout(8000) }
    );
    results.q2_status = r2.status;
    results.q2_body = await r2.json();
  } catch (e) { results.q2_error = e.message; }
  try {
    const r3 = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
      { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(6000) }
    );
    const cj = await r3.json();
    results.chart_meta = cj?.chart?.result?.[0]?.meta ? Object.keys(cj.chart.result[0].meta) : 'no meta';
    results.chart_meta_vals = cj?.chart?.result?.[0]?.meta;
  } catch (e) { results.chart_error = e.message; }
  res.json(results);
});

// ── 銘柄詳細 (ファンダメンタル+テクニカル+レジサポ) ──
app.get('/api/stock-detail', async (req, res) => {
  const code0 = String(req.query.symbol || '').trim();
  const sym = /^\d{3,5}[A-Z]?$/.test(code0) ? code0 + '.T' : code0;
  try {
    const modules = 'summaryDetail,defaultKeyStatistics,financialData,calendarEvents';
    const doFetch = async (force) => {
      const { cookie, crumb } = await getYahooAuth(force);
      return fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
        { headers: { 'User-Agent': YH_UA, 'Cookie': cookie }, signal: AbortSignal.timeout(10000) }
      ).then(r => r.json());
    };
    const raw = (obj, k) => obj?.[k]?.raw ?? null;
    const fmt = (obj, k) => obj?.[k]?.fmt ?? null;

    let sd = {}, ks = {}, fd = {}, ce = {};
    let quoteSummaryOk = false;
    let quoteSummaryError = null;

    // Google Finance からスクレイピング（認証不要、サーバーIPブロックなし）
    const isJP = sym.endsWith('.T');
    if (isJP) {
      try {
        const code = sym.replace(/\.T$/, '');
        const gfUrl = `https://www.google.com/finance/quote/${encodeURIComponent(code)}:TYO`;
        const html = await fetch(gfUrl, {
          headers: { 'User-Agent': YH_UA, 'Accept': 'text/html', 'Accept-Language': 'ja,en;q=0.5' },
          signal: AbortSignal.timeout(10000),
        }).then(r => r.text());
        // Google Finance: <div class="SwQK7">ラベル</div><div class="dO6ijd">値</div> を全て抽出
        const metrics = {};
        const re = /<div[^>]*class="[^"]*SwQK7[^"]*"[^>]*>([^<]+)<\/div>\s*<div[^>]*class="[^"]*dO6ijd[^"]*"[^>]*>([^<]+)<\/div>/gi;
        let match;
        while ((match = re.exec(html)) !== null) {
          metrics[match[1].trim()] = match[2].trim();
        }
        console.log(`[google-scrape] ${sym} metrics:`, JSON.stringify(metrics));
        const toNum = (s) => {
          if (!s || s === '-' || s === '—' || s === '---') return null;
          const clean = s.replace(/[￥¥,、]/g, '').replace(/%$/, '');
          const n = parseFloat(clean);
          return isNaN(n) ? null : n;
        };
        const gm = (keys) => { for (const k of keys) { if (metrics[k]) return metrics[k]; } return null; };
        const perVal = toNum(gm(['株価収益率','P/E ratio','PER']));
        const pbrVal = toNum(gm(['株価純資産倍率','P/B ratio','PBR','Price-to-book']));
        const dyVal = toNum(gm(['配当','配当利回り','Dividend yield']));
        const epsVal = toNum(gm(['EPS']));
        const w52h = toNum(gm(['52 週高値','52-week high']));
        const w52l = toNum(gm(['52 週安値','52-week low']));
        const mcapText = gm(['時価総額','Market cap']);
        let mcap = null;
        if (mcapText) {
          const mcn = parseFloat(mcapText.replace(/[^\d.]/g, ''));
          if (!isNaN(mcn)) {
            if (mcapText.includes('兆')) mcap = mcn * 1e12;
            else if (mcapText.includes('億')) mcap = mcn * 1e8;
            else if (mcapText.includes('T')) mcap = mcn * 1e12;
            else if (mcapText.includes('B')) mcap = mcn * 1e9;
            else mcap = mcn;
          }
        }
        console.log(`[google-scrape] ${sym} PER=${perVal} PBR=${pbrVal} DY=${dyVal} EPS=${epsVal} w52h=${w52h} mcap=${mcapText}`);

        if (perVal != null) sd.trailingPE = { raw: perVal };
        if (pbrVal != null) ks.priceToBook = { raw: pbrVal };
        if (dyVal != null) sd.dividendYield = { raw: dyVal / 100 };
        if (w52h != null) sd.fiftyTwoWeekHigh = { raw: w52h };
        if (w52l != null) sd.fiftyTwoWeekLow = { raw: w52l };
        if (mcap != null) sd.marketCap = { raw: mcap };
        if (perVal != null || dyVal != null || w52h != null) quoteSummaryOk = true;
        // 会社概要を抽出（Google Finance の bLLb2d クラス）
        const descMatch = html.match(/<div[^>]*class="[^"]*bLLb2d[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (descMatch) {
          sd._companyDesc = descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);
        }
      } catch (e) {
        quoteSummaryError = 'google scrape failed: ' + e.message;
      }
    }

    // Yahoo US quoteSummary (US株 or JP scrape失敗時のフォールバック)
    if (!quoteSummaryOk) {
      try {
        let j = await doFetch(false);
        if (j.finance?.error?.code === 'Unauthorized' || j.quoteSummary?.error?.code === 'Unauthorized') j = await doFetch(true);
        const rs = j.quoteSummary?.result?.[0];
        if (rs) { sd = rs.summaryDetail || {}; ks = rs.defaultKeyStatistics || {}; fd = rs.financialData || {}; ce = rs.calendarEvents || {}; quoteSummaryOk = true; }
        else { quoteSummaryError = JSON.stringify(j.finance?.error || j.quoteSummary?.error || 'no result').slice(0, 200); }
      } catch (qe) { quoteSummaryError = qe.message; }
    }
    console.log(`[stock-detail] ${sym} quoteSummary=${quoteSummaryOk}${quoteSummaryError ? ' err=' + quoteSummaryError : ''}`);

    // 価格情報（chart APIから必ず取得 — quoteSummaryが失敗しても動作する）
    let price = raw(sd, 'regularMarketPrice') || raw(fd, 'currentPrice');
    let prevClose = raw(sd, 'regularMarketPreviousClose') || raw(sd, 'previousClose');
    let open = raw(sd, 'regularMarketOpen') || raw(sd, 'open');
    let dayHigh = raw(sd, 'regularMarketDayHigh') || raw(sd, 'dayHigh');
    let dayLow = raw(sd, 'regularMarketDayLow') || raw(sd, 'dayLow');
    let volume = raw(sd, 'regularMarketVolume') || raw(sd, 'volume');
    if (!price) {
      try {
        const cj = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
          { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(6000) }).then(r => r.json());
        const cr = cj?.chart?.result?.[0];
        const m = cr?.meta;
        if (m) {
          price = m.regularMarketPrice;
          prevClose = prevClose || m.chartPreviousClose || m.previousClose;
        }
        const q = cr?.indicators?.quote?.[0];
        const ts = cr?.timestamp;
        if (q && ts?.length) {
          const last = ts.length - 1;
          open = open || q.open?.[last];
          dayHigh = dayHigh || q.high?.[last];
          dayLow = dayLow || q.low?.[last];
          volume = volume || q.volume?.[last];
        }
      } catch {}
    }
    const week52High = raw(sd, 'fiftyTwoWeekHigh');
    const week52Low = raw(sd, 'fiftyTwoWeekLow');
    const avgVolume = raw(sd, 'averageDailyVolume10Day');

    // ファンダメンタル
    const fundamental = {
      trailingPE: raw(sd, 'trailingPE'), forwardPE: raw(sd, 'forwardPE'),
      priceToBook: raw(ks, 'priceToBook'), pegRatio: raw(ks, 'pegRatio'),
      marketCap: raw(sd, 'marketCap'),
      enterpriseToEbitda: raw(ks, 'enterpriseToEbitda'),
      dividendYield: raw(sd, 'dividendYield'), payoutRatio: raw(sd, 'payoutRatio'),
      roe: raw(fd, 'returnOnEquity'), roa: raw(fd, 'returnOnAssets'),
      operatingMargins: raw(fd, 'operatingMargins'), profitMargins: raw(fd, 'profitMargins'),
      revenueGrowth: raw(fd, 'revenueGrowth'), earningsGrowth: raw(fd, 'earningsGrowth'),
      debtToEquity: raw(fd, 'debtToEquity'), currentRatio: raw(fd, 'currentRatio'),
      targetMeanPrice: raw(fd, 'targetMeanPrice'),
      recommendationKey: fd.recommendationKey || null,
      numberOfAnalystOpinions: raw(fd, 'numberOfAnalystOpinions'),
    };

    // 決算日
    const earningsDates = ce.earnings?.earningsDate;
    const nextEarnings = earningsDates?.length ? earningsDates[0].fmt : null;

    // テクニカル (日足1年分からMA・RSI・レジサポ算出)
    let technical = null;
    try {
      const cj = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`,
        { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(8000) }
      ).then(r => r.json());
      const cr = cj?.chart?.result?.[0];
      if (cr) {
        const closes = cr.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
        const highs = cr.indicators?.quote?.[0]?.high?.filter(v => v != null) || [];
        const lows = cr.indicators?.quote?.[0]?.low?.filter(v => v != null) || [];
        const n = closes.length;
        const sma = (arr, p) => arr.length >= p ? arr.slice(-p).reduce((s,v) => s+v, 0) / p : null;
        const ma5 = sma(closes, 5), ma25 = sma(closes, 25), ma75 = sma(closes, 75), ma200 = sma(closes, 200);
        // RSI (14)
        let gains = 0, losses = 0;
        const rsiPeriod = 14;
        for (let i = Math.max(1, n - rsiPeriod); i < n; i++) {
          const d = closes[i] - closes[i-1];
          if (d > 0) gains += d; else losses -= d;
        }
        const rsi = (gains + losses) > 0 ? Math.round(gains / (gains + losses) * 100) : null;
        // レジスタンス / サポート (直近60日の高値安値 + ピボット)
        const recent = closes.slice(-60);
        const recentHighs = highs.slice(-60);
        const recentLows = lows.slice(-60);
        const support1 = recentLows.length ? Math.min(...recentLows) : null;
        const resistance1 = recentHighs.length ? Math.max(...recentHighs) : null;
        const lastC = closes[n - 1], lastH = highs[highs.length - 1] || lastC, lastL = lows[lows.length - 1] || lastC;
        const pivot = (lastH + lastL + lastC) / 3;
        const s1 = 2 * pivot - lastH;
        const r1 = 2 * pivot - lastL;
        // ボリンジャーバンド (20)
        const bb20 = closes.slice(-20);
        const bbMean = bb20.reduce((s,v) => s+v, 0) / bb20.length;
        const bbStd = Math.sqrt(bb20.reduce((s,v) => s + (v-bbMean)**2, 0) / bb20.length);
        technical = {
          ma5: ma5 ? Math.round(ma5) : null, ma25: ma25 ? Math.round(ma25) : null,
          ma75: ma75 ? Math.round(ma75) : null, ma200: ma200 ? Math.round(ma200) : null,
          rsi,
          bbUpper: Math.round(bbMean + 2*bbStd), bbMiddle: Math.round(bbMean), bbLower: Math.round(bbMean - 2*bbStd),
          pivot: Math.round(pivot), pivotS1: Math.round(s1), pivotR1: Math.round(r1),
          support60d: support1 ? Math.round(support1) : null,
          resistance60d: resistance1 ? Math.round(resistance1) : null,
        };
      }
    } catch {}

    if (!price && !quoteSummaryOk) throw new Error('価格データを取得できませんでした');
    res.json({
      symbol: sym, price, prevClose, open, dayHigh, dayLow,
      week52High, week52Low, volume, avgVolume,
      fundamental, technical, nextEarnings,
      companyDesc: sd._companyDesc || null,
      currency: sd.currency || 'JPY',
      quoteSummaryOk, quoteSummaryError,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screener/run', async (req, res) => {
  const id = String(req.query.id || '');
  const universe = String(req.query.universe || 'nikkei225');
  const combo = COMBO_CHECKS[id];
  if (!combo) return res.status(400).json({ error: '不明な組み合わせID' });
  try {
    const stocks = await fetchN225Indicators(universe);
    const hits = [];
    for (const s of stocks) {
      try {
        if (combo.check(s, s.price)) hits.push({
          code: s.code, symbol: s.symbol, name: s.name, price: s.price,
          detail: combo.detail(s, s.price),
        });
      } catch {}
    }
    hits.sort((a, b) => a.code.localeCompare(b.code));
    res.json({ id, label: combo.label, chapter: combo.chapter, universe, total: stocks.length, fetchTotal: getUniverseCodes(universe).length, count: hits.length, hits: hits.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ファンダメンタル スクリーナー ──
// 本Vol3(ファンダメンタル分析)・Vol5(買っていい株の選び方) の条件で日経225を絞る
let fundCache = {}; // { universe: { ts, data } }
const FUND_CACHE_TTL = 12 * 60 * 60 * 1000; // 12時間（ファンダは日々ほぼ変わらない）

async function fetchOneFundamentals(sym) {
  const modules = 'summaryDetail,defaultKeyStatistics,financialData';
  const doFetch = async (force) => {
    const { cookie, crumb } = await getYahooAuth(force);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
      { headers: { 'User-Agent': YH_UA, 'Cookie': cookie }, signal: AbortSignal.timeout(8000) }
    );
    return r.json();
  };
  try {
    let j = await doFetch(false);
    if (j.finance?.error?.code === 'Unauthorized' || j.quoteSummary?.error?.code === 'Unauthorized') {
      j = await doFetch(true);
    }
    const rs = j.quoteSummary?.result?.[0];
    if (!rs) return null;
    const sd = rs.summaryDetail || {}, ks = rs.defaultKeyStatistics || {}, fd = rs.financialData || {};
    const raw = (obj, k) => obj?.[k]?.raw ?? null;
    return {
      price: raw(sd, 'regularMarketPrice') || raw(fd, 'currentPrice'),
      marketCap: raw(sd, 'marketCap'),
      trailingPE: raw(sd, 'trailingPE'),
      forwardPE: raw(sd, 'forwardPE'),
      priceToBook: raw(ks, 'priceToBook'),
      pegRatio: raw(ks, 'pegRatio'),
      enterpriseToEbitda: raw(ks, 'enterpriseToEbitda'),
      priceToSalesTTM: raw(ks, 'priceToSalesTrailing12Months'),
      dividendYield: raw(sd, 'dividendYield'),
      payoutRatio: raw(sd, 'payoutRatio'),
      roe: raw(fd, 'returnOnEquity'),
      roa: raw(fd, 'returnOnAssets'),
      debtToEquity: raw(fd, 'debtToEquity'),
      currentRatio: raw(fd, 'currentRatio'),
      revenueGrowth: raw(fd, 'revenueGrowth'),
      earningsGrowth: raw(fd, 'earningsGrowth'),
      operatingMargins: raw(fd, 'operatingMargins'),
      profitMargins: raw(fd, 'profitMargins'),
    };
  } catch { return null; }
}

async function fetchN225Fundamentals(universe = 'nikkei225') {
  const now = Date.now();
  const cache = fundCache[universe];
  if (cache && cache.data.length && (now - cache.ts) < FUND_CACHE_TTL) return cache.data;
  const codes = getUniverseCodes(universe);
  if (!codes.length) { fundCache[universe] = { ts: now, data: [] }; return []; }
  const BATCH = 8, out = [];
  for (let i = 0; i < codes.length; i += BATCH) {
    await Promise.all(codes.slice(i, i+BATCH).map(async code => {
      const sym = `${code}.T`;
      const f = await fetchOneFundamentals(sym);
      if (!f || !f.price) return;
      // 銘柄名も一緒に取得（chart API のメタから）
      let name = code;
      try {
        const cr = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
          { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(5000) }
        ).then(r => r.json());
        name = cr?.chart?.result?.[0]?.meta?.shortName || cr?.chart?.result?.[0]?.meta?.longName || code;
      } catch {}
      out.push({ code, symbol: sym, name, ...f });
    }));
    if (i + BATCH < codes.length) await new Promise(r => setTimeout(r, 250));
  }
  fundCache[universe] = { ts: now, data: out };
  return out;
}

// パーセント表示ヘルパー
const fmtPct = (v) => v != null ? (v * 100).toFixed(1) + '%' : '-';
const fmtNum = (v, d=1) => v != null ? v.toFixed(d) : '-';
const fmtMcap = (v) => v != null ? (v >= 1e12 ? (v/1e12).toFixed(1)+'兆' : v >= 1e8 ? (v/1e8).toFixed(0)+'億' : v.toLocaleString()) : '-';

// 各コンボ: {label, book('picks'|'fund'), chapter, check(f)=>bool, detail(f)=>str}
const FUND_COMBOS = {
  low_per: {
    label: '株価収益率(PER)が低め・割安', book: 'picks', chapter: '第19章',
    check: f => f.trailingPE != null && f.trailingPE > 0 && f.trailingPE < 12,
    detail: f => `PER ${fmtNum(f.trailingPE,1)}倍 / PBR ${fmtNum(f.priceToBook,2)}倍 / 配当利回り ${fmtPct(f.dividendYield)}`,
  },
  low_pbr: {
    label: '株価純資産倍率(PBR)が低め・割安', book: 'picks', chapter: '第20章',
    check: f => f.priceToBook != null && f.priceToBook > 0 && f.priceToBook < 1.0,
    detail: f => `PBR ${fmtNum(f.priceToBook,2)}倍 / PER ${fmtNum(f.trailingPE,1)}倍 / ROE ${fmtPct(f.roe)}`,
  },
  deep_value: {
    label: '超割安（PER10倍未満・かつ・PBR1倍未満）', book: 'picks', chapter: '第19章',
    check: f => f.trailingPE != null && f.trailingPE > 0 && f.trailingPE < 10 && f.priceToBook != null && f.priceToBook < 1.0,
    detail: f => `PER ${fmtNum(f.trailingPE,1)}倍 / PBR ${fmtNum(f.priceToBook,2)}倍`,
  },
  high_div: {
    label: '高配当（利回り3〜6%）', book: 'picks', chapter: '第24章',
    check: f => f.dividendYield != null && f.dividendYield >= 0.03 && f.dividendYield <= 0.06,
    detail: f => `配当利回り ${fmtPct(f.dividendYield)} / PER ${fmtNum(f.trailingPE,1)}倍 / 配当性向 ${fmtPct(f.payoutRatio)}`,
  },
  div_value: {
    label: '配当と割安の両立（PER15倍未満・配当3%超）', book: 'picks', chapter: '第19章',
    check: f => f.trailingPE != null && f.trailingPE > 0 && f.trailingPE < 15 && f.dividendYield != null && f.dividendYield >= 0.03,
    detail: f => `PER ${fmtNum(f.trailingPE,1)}倍 / 配当利回り ${fmtPct(f.dividendYield)}`,
  },
  high_roe: {
    label: '稼ぐ力が高い（自己資本利益率15%超）', book: 'fund', chapter: '第8章',
    check: f => f.roe != null && f.roe >= 0.15,
    detail: f => `ROE ${fmtPct(f.roe)} / PBR ${fmtNum(f.priceToBook,2)}倍 / 営業利益率 ${fmtPct(f.operatingMargins)}`,
  },
  quality_roe_low_debt: {
    label: '質の高い企業（稼ぐ力+借金少なめ）', book: 'picks', chapter: '第15章',
    check: f => f.roe != null && f.roe >= 0.12 && f.debtToEquity != null && f.debtToEquity < 50,
    detail: f => `ROE ${fmtPct(f.roe)} / 有利子負債÷自己資本 ${fmtNum(f.debtToEquity,0)}%`,
  },
  growth: {
    label: '成長株（売上もしくは利益が二桁成長）', book: 'picks', chapter: '第14章',
    check: f => (f.revenueGrowth != null && f.revenueGrowth >= 0.10) || (f.earningsGrowth != null && f.earningsGrowth >= 0.15),
    detail: f => `売上成長率 ${fmtPct(f.revenueGrowth)} / 利益成長率 ${fmtPct(f.earningsGrowth)}`,
  },
  peg_growth_value: {
    label: '成長性を考慮した割安（PEG1倍未満）', book: 'picks', chapter: '第18章',
    check: f => f.pegRatio != null && f.pegRatio > 0 && f.pegRatio < 1.0 && f.earningsGrowth != null && f.earningsGrowth > 0.10,
    detail: f => `PEG ${fmtNum(f.pegRatio,2)}倍 / 利益成長率 ${fmtPct(f.earningsGrowth)}`,
  },
  ev_ebitda_low: {
    label: '企業価値ベースで割安（EV÷EBITDA 8倍未満）', book: 'fund', chapter: '第24章',
    check: f => f.enterpriseToEbitda != null && f.enterpriseToEbitda > 0 && f.enterpriseToEbitda < 8,
    detail: f => `EV/EBITDA ${fmtNum(f.enterpriseToEbitda,1)}倍`,
  },
  low_psr: {
    label: '売上ベースで割安（株価売上高倍率 1倍未満）', book: 'fund', chapter: '第23章',
    check: f => f.priceToSalesTTM != null && f.priceToSalesTTM > 0 && f.priceToSalesTTM < 1.0,
    detail: f => `PSR ${fmtNum(f.priceToSalesTTM,2)}倍`,
  },
  safe_finance: {
    label: '財務が健全（借金少・支払余力あり）', book: 'picks', chapter: '第10章',
    check: f => f.debtToEquity != null && f.debtToEquity < 50 && f.currentRatio != null && f.currentRatio > 1.3,
    detail: f => `有利子負債÷自己資本 ${fmtNum(f.debtToEquity,0)}% / 流動比率 ${fmtNum(f.currentRatio,2)}`,
  },
  large_quality: {
    label: '大型優良株（時価総額大・PER低め・配当あり）', book: 'picks', chapter: '第5章',
    check: f => f.marketCap != null && f.marketCap >= 5e11 && f.trailingPE != null && f.trailingPE > 0 && f.trailingPE < 20 && f.dividendYield != null && f.dividendYield >= 0.02,
    detail: f => `時価総額 ${fmtMcap(f.marketCap)}円 / PER ${fmtNum(f.trailingPE,1)}倍 / 配当利回り ${fmtPct(f.dividendYield)}`,
  },
  payout_sustainable: {
    label: '配当が持続可能（配当性向30〜70%）', book: 'picks', chapter: '第25章',
    check: f => f.payoutRatio != null && f.payoutRatio >= 0.30 && f.payoutRatio <= 0.70 && f.dividendYield != null && f.dividendYield >= 0.02,
    detail: f => `配当性向 ${fmtPct(f.payoutRatio)} / 配当利回り ${fmtPct(f.dividendYield)}`,
  },
  high_margin: {
    label: '高利益率（営業利益率20%超）', book: 'fund', chapter: '第7章',
    check: f => f.operatingMargins != null && f.operatingMargins >= 0.20,
    detail: f => `営業利益率 ${fmtPct(f.operatingMargins)} / ROE ${fmtPct(f.roe)}`,
  },
};

app.get('/api/fund-screener/combos', (_req, res) => {
  const combos = Object.entries(FUND_COMBOS).map(([id, c]) => ({
    id, label: c.label, book: c.book, chapter: c.chapter,
  }));
  res.json({ combos });
});

// データ取得状況の診断: 各指標がN225のうち何銘柄で取得できたかを返す
app.get('/api/fund-screener/debug', async (_req, res) => {
  try {
    const stocks = await fetchN225Fundamentals();
    const fields = ['trailingPE','priceToBook','dividendYield','payoutRatio','roe','roa','debtToEquity','currentRatio','revenueGrowth','earningsGrowth','pegRatio','enterpriseToEbitda','priceToSalesTTM','operatingMargins','profitMargins','marketCap'];
    const fieldCounts = {};
    for (const f of fields) fieldCounts[f] = { available: stocks.filter(s => s[f] != null).length, total: stocks.length };
    res.json({ totalFetched: stocks.length, targetTotal: NIKKEI225.length, fields: fieldCounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fund-screener/run', async (req, res) => {
  const id = String(req.query.id || '');
  const universe = String(req.query.universe || 'nikkei225');
  const combo = FUND_COMBOS[id];
  if (!combo) return res.status(400).json({ error: '不明な組み合わせID' });
  try {
    const stocks = await fetchN225Fundamentals(universe);
    const hits = [];
    for (const s of stocks) {
      try {
        if (combo.check(s)) hits.push({
          code: s.code, symbol: s.symbol, name: s.name, price: s.price,
          detail: combo.detail(s),
        });
      } catch {}
    }
    hits.sort((a, b) => a.code.localeCompare(b.code));
    res.json({
      id, label: combo.label, book: combo.book, chapter: combo.chapter, universe,
      total: stocks.length, fetchTotal: getUniverseCodes(universe).length,
      count: hits.length, hits: hits.slice(0, 50),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function runScreening(date) {
  const BATCH = 12, candidates = [];
  for (let i = 0; i < NIKKEI225.length; i += BATCH) {
    await Promise.all(NIKKEI225.slice(i, i+BATCH).map(async code => {
      try {
        const sym = `${code}.T`;
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=4mo`,
          { headers: { 'User-Agent': YH_UA }, signal: AbortSignal.timeout(8000) }
        );
        const d = await r.json();
        const result = d?.chart?.result?.[0];
        const closes = result?.indicators?.quote?.[0]?.close?.filter(v => v != null);
        if (!closes || closes.length < 35) return;
        const score = scoreStock(closes);
        if (score.count >= 2) candidates.push({
          code, symbol: sym,
          name: result.meta?.shortName || result.meta?.longName || code,
          price: closes[closes.length-1],
          signals: score.count, reasons: score.signals, rsi: score.rsi,
        });
      } catch {}
      screening.done++;
    }));
    if (i + BATCH < NIKKEI225.length) await new Promise(r => setTimeout(r, 300));
  }
  candidates.sort((a, b) => b.signals - a.signals || (a.rsi||50) - (b.rsi||50));
  screening.results = candidates.slice(0, 5);
  screening.status = 'done';
  screening.date = date;
  console.log(`[screening] ${date} 完了: ${candidates.length}銘柄ヒット → 上位${screening.results.length}銘柄`);
}

// ── 投資スタイル診断 ──
app.get('/api/style-diagnosis', async (_req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API キーが未設定です' });
  const buys = getBuys();
  const sells = getRealized();
  if (buys.length + sells.length < 3) return res.status(400).json({ error: '売買記録が少なすぎます（3件以上必要）' });
  const lines = (p) => {
    const all = [
      ...buys.filter(b => b.person === p).map(b => ({ ...b, type: 'buy' })),
      ...sells.filter(s => s.person === p).map(s => ({ ...s, type: 'sell' })),
    ].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return all.map(t => {
      const d = new Date(t.ts || 0);
      const ds = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
      const sym = (t.currency || 'JPY') === 'JPY' ? '¥' : '$';
      if (t.type === 'buy') return `${ds} 買 ${t.name||t.ticker} ${t.shares}株 @${sym}${t.price}${t.reason ? ` 理由:${t.reason}` : ''}`;
      return `${ds} 売 ${t.name||t.ticker} 実現${t.realized >= 0 ? '+' : ''}${sym}${Math.round(t.realized||0)}${t.reason ? ` 理由:${t.reason}` : ''}`;
    }).join('\n') || 'なし';
  };
  const prompt = `あなたは個人投資家の行動分析の専門家です。以下の2人の売買記録を分析して、それぞれの投資スタイルを診断してください。

【ひろの売買記録】
${lines('mine')}

【ちかの売買記録】
${lines('hers')}

各人について以下の形式で回答してください：
・スタイル名（例：「順張り・短期トレード型」「バリュー・長期保有型」など、15字以内のキャッチーな名前）
・特徴を2〜3行で説明
・得意なこと1つ、注意点1つ
・一言アドバイス
専門用語は避け、親しみやすい口調で。データにないことは推測しすぎないこと。`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e.error?.message || `API ${response.status}`); }
    const data = await response.json();
    res.json({ text: data.content?.[0]?.text?.trim() || '' });
  } catch (e) {
    console.error('[style-diagnosis]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ベンチマーク比較 ──
app.get('/api/benchmark', async (_req, res) => {
  const hold = getHoldings();
  if (!hold.length) return res.json({ error: '保有銘柄がありません' });
  let usdjpy = 157;
  try {
    const fx = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1d&range=5d', { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
    const c = fx.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const v = c.filter(Boolean).slice(-1)[0]; if (v) usdjpy = v;
  } catch {}
  const fetchBenchmark = async (sym, range) => {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`, { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
      const r0 = j.chart?.result?.[0];
      if (!r0) return null;
      const closes = r0.indicators?.quote?.[0]?.close || [];
      const first = closes.find(Boolean);
      const last = [...closes].reverse().find(Boolean);
      if (!first || !last) return null;
      return Math.round((last - first) / first * 1000) / 10;
    } catch { return null; }
  };
  const [nk1m, nk6m, nk1y, sp1m, sp6m, sp1y] = await Promise.all([
    fetchBenchmark('^N225', '1mo'), fetchBenchmark('^N225', '6mo'), fetchBenchmark('^N225', '1y'),
    fetchBenchmark('^GSPC', '1mo'), fetchBenchmark('^GSPC', '6mo'), fetchBenchmark('^GSPC', '1y'),
  ]);
  // ポートフォリオリターン（person別）
  const portfolioReturn = async (person, range) => {
    try {
      const ph = hold.filter(h => (h.person === 'hers' ? 'hers' : 'mine') === person);
      if (!ph.length) return null;
      const tickers = [...new Set(ph.map(h => h.ticker))];
      let startVal = 0, endVal = 0;
      for (const t of tickers) {
        const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=${range}`, { headers: { 'User-Agent': YH_UA } }).then(r => r.json());
        const r0 = j.chart?.result?.[0];
        if (!r0) continue;
        const closes = r0.indicators?.quote?.[0]?.close || [];
        const fx = r0.meta?.currency === 'USD' ? usdjpy : 1;
        const hs = ph.filter(h => h.ticker === t);
        const first = closes.find(Boolean), last = [...closes].reverse().find(Boolean);
        if (!first || !last) continue;
        const sh = hs.reduce((s, h) => s + h.shares, 0);
        startVal += first * sh * fx; endVal += last * sh * fx;
      }
      if (!startVal) return null;
      return Math.round((endVal - startVal) / startVal * 1000) / 10;
    } catch { return null; }
  };
  const [hiro1m, hiro6m, hiro1y, chika1m, chika6m, chika1y] = await Promise.all([
    portfolioReturn('mine','1mo'), portfolioReturn('mine','6mo'), portfolioReturn('mine','1y'),
    portfolioReturn('hers','1mo'), portfolioReturn('hers','6mo'), portfolioReturn('hers','1y'),
  ]);
  res.json({
    hiro:   { '1mo': hiro1m,  '6mo': hiro6m,  '1y': hiro1y  },
    chika:  { '1mo': chika1m, '6mo': chika6m, '1y': chika1y },
    nikkei: { '1mo': nk1m,   '6mo': nk6m,    '1y': nk1y    },
    sp500:  { '1mo': sp1m,   '6mo': sp6m,    '1y': sp1y    },
  });
});

// ── プッシュ通知設定 ──
app.get('/api/push-settings', (_req, res) => res.json(getPushSettings()));
app.post('/api/push-settings', async (req, res) => {
  await savePushSettings(req.body);
  res.json(getPushSettings());
});

// ── 全データのバックアップ／復元（写真込み） ──
// 復元アップロードは写真込みで大きくなるため専用multer（express.jsonの上限を回避）
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
app.get('/api/backup', (_req, res) => {
  const dump = exportAll();
  const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="shiftshare-backup-${stamp}.json"`);
  res.send(JSON.stringify(dump));
});
app.post('/api/restore', backupUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
    let payload;
    try { payload = JSON.parse(req.file.buffer.toString('utf8')); }
    catch { return res.status(400).json({ error: 'JSONとして読み込めませんでした' }); }
    const r = await importAll(payload);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── 週次・月次レポート自動送信 ──
async function sendPushReport(title, body) {
  const subs = getPushSubscriptions();
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body });
  for (const sub of subs) webpush.sendNotification(sub, payload).catch(() => {});
}
async function buildReportBody() {
  const holds = getHoldings();
  const realized = getRealized();
  const now = new Date();
  const realized7d = realized.filter(r => r.ts && now - r.ts < 7 * 86400000);
  const totalRealized7d = realized7d.reduce((s, r) => {
    const jpy = (r.currency === 'USD') ? (r.realized || 0) * 157 : (r.realized || 0);
    return s + jpy;
  }, 0);
  const lines = [];
  if (totalRealized7d !== 0) lines.push(`実現損益: ${totalRealized7d >= 0 ? '+' : ''}¥${Math.round(totalRealized7d).toLocaleString()}`);
  lines.push(`保有銘柄: ${holds.length}銘柄`);
  return lines.join(' / ');
}
// ── 定期レポート（週次・月次）──
// 旧実装は30分ごとのsetIntervalで常駐していたため、サーバーがスリープできず
// Renderの無料枠（約750時間/月）を1サービスで使い切っていた。
// アクセス契機でチェックする方式に変更し、無アクセス時はスリープできるようにする。
// 「8時ちょうど」ではなく「その日まだ送っていなければ送る」方式（最後に送った日を永続化）。
let _lastReportCheck = 0;
async function maybeSendScheduledReports() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const nowMs = Date.now();
  if (nowMs - _lastReportCheck < 5 * 60 * 1000) return; // 負荷軽減：5分に1回までチェック
  _lastReportCheck = nowMs;
  const settings = getPushSettings();
  if (!settings.weeklyReport && !settings.monthlyReport) return;
  const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  if (jstNow.getHours() < 8) return; // 早朝は通知しない
  const weekday = jstNow.getDay(), date = jstNow.getDate(), today = jstNow.toDateString();
  if (settings.weeklyReport && weekday === 1 && settings.lastWeeklyReport !== today) {
    await savePushSettings({ lastWeeklyReport: today });
    await sendPushReport('📊 週次レポート', await buildReportBody());
    console.log('[weekly-report] 送信完了');
  }
  if (settings.monthlyReport && date === 1 && settings.lastMonthlyReport !== today) {
    await savePushSettings({ lastMonthlyReport: today });
    await sendPushReport('📈 月次レポート', await buildReportBody());
    console.log('[monthly-report] 送信完了');
  }
}

const PORT = process.env.PORT || 8000;
await initDb();
app.listen(PORT, () => {
  console.log(`\n  ShiftShare 起動中 → http://localhost:${PORT}\n`);
});
