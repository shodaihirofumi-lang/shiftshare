import fs from 'fs';
import { Redis } from '@upstash/redis';

const DB_FILE = 'data.json';
const REDIS_KEY = 'shiftshare:data';
// 写真は別Key/別ファイルに分離（メインblobを軽く保つため）
const PHOTOS_KEY = 'shiftshare:photos'; // Redis Hash: field=photo:{date} or memo-img:{id}
const PHOTOS_FILE = 'photos.json';

// Upstash Redis を使うのは環境変数が両方ある時だけ。
// 無ければローカルファイル(data.json)にフォールバック（ローカル開発用）。
const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = useRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

const empty = () => ({ shifts: [], pushSubscriptions: [], uploadLog: {}, avatars: {}, events: [], wages: {}, locations: {}, expenses: [], gcalUrls: {}, gtasksTokens: {}, holdings: [], notes: [], memos: [], notifiedOff: {}, realized: [], buys: [], diaries: {}, monthlyDiaries: {}, photoIndex: [], moveAlerts: {}, goals: [], targetPrices: [] });

// 全データをメモリにキャッシュ。読み取りは同期、書き込み時に永続化。
let cache = empty();
// 写真専用キャッシュ（メインのpersist()とは独立）
// key: "photo:{YYYY-MM-DD}" or "memo-img:{memoId}" → base64 string
let photoCache = {};

export async function initDb() {
  if (useRedis) {
    try {
      const data = await redis.get(REDIS_KEY);
      cache = data ? { ...empty(), ...data } : empty();
      console.log('[db] Upstash Redis を使用（永続）');
    } catch (e) {
      console.error('[db] Redis 読み込み失敗、空で開始:', e.message);
      cache = empty();
    }
  } else {
    try {
      cache = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    } catch {
      cache = empty();
    }
    console.log('[db] ローカルファイル data.json を使用（クラウドでは消えます）');
  }
  await migratePhotosToSeparateStore(); // 旧来のインライン画像を分離（photoIndex更新前に実行）
  await migratePhotoSingleToMulti();   // 写真1枚→複数枚形式へ（photoIndex更新前に実行）
  await buildPhotoIndexFromHash();     // 初回: Redis hash から photoIndex を構築
  await loadPhotoCache();             // photoIndex を元に個別 hget で写真を取得
  await mergeDuplicateHoldings();
}

// 写真専用ストアをロード
// photoIndex（メインblobに保存）を元に個別 hget で 1 枚ずつ取得する。
// hgetall / hscan は Upstash 無料プランの 1MB レスポンス制限でファイルが増えると失敗するため使わない。
async function loadPhotoCache() {
  if (useRedis) {
    photoCache = {};
    const index = cache.photoIndex || [];
    let loaded = 0;
    for (const entry of index) {
      try {
        const v = await redis.hget(PHOTOS_KEY, entry.field);
        if (v !== null && v !== undefined) {
          photoCache[entry.field] = typeof v === 'string' ? v : JSON.stringify(v);
          loaded++;
        }
      } catch (e) {
        console.error(`[db] 写真hget失敗(${entry.field}):`, e.message);
      }
    }
    console.log(`[db] 写真ストア: ${loaded}/${index.length} 件`);
  } else {
    try {
      photoCache = JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8'));
    } catch { photoCache = {}; }
    console.log(`[db] 写真ストア(ローカル): ${Object.keys(photoCache).length} 件`);
  }
}

// 起動後に写真キャッシュをRedisから再ロード（エラーリカバリ用）
export async function reloadPhotoCache() {
  if (!useRedis) return;
  const index = cache.photoIndex || [];
  let loaded = 0;
  for (const entry of index) {
    try {
      const v = await redis.hget(PHOTOS_KEY, entry.field);
      if (v !== null && v !== undefined) {
        photoCache[entry.field] = typeof v === 'string' ? v : JSON.stringify(v);
        loaded++;
      }
    } catch (e) {
      console.error(`[db] 写真再ロードhget失敗(${entry.field}):`, e.message);
    }
  }
  console.log(`[db] 写真ストア再ロード: ${loaded}/${index.length} 件`);
}

// 既存の Redis hash から photoIndex を構築（初回デプロイ時の1回限りマイグレーション）
// HKEYS はフィールド名のみ返す（写真データ含まず）ため 1MB 制限に引っかからない
async function buildPhotoIndexFromHash() {
  if (!useRedis) return;
  if ((cache.photoIndex || []).length > 0) return; // 既にインデックスあり → スキップ
  try {
    const fields = await redis.hkeys(PHOTOS_KEY);
    if (!fields || fields.length === 0) {
      if (!cache.photoIndex) { cache.photoIndex = []; await persist(); }
      console.log('[db] 写真hash: フィールドなし（新規または空）');
      return;
    }
    cache.photoIndex = fields
      .filter(f => f.startsWith('photo:') || f.startsWith('memo-img:'))
      .map(field => {
        let date = null;
        if (field.startsWith('photo:')) {
          const rest = field.slice(6);
          const sep = rest.indexOf(':');
          if (sep >= 0) date = rest.slice(0, sep);
        }
        return { field, person: null, date };
      });
    await persist();
    console.log(`[db] 写真インデックス構築完了: ${cache.photoIndex.length} 件`);
  } catch (e) {
    console.error('[db] 写真インデックス構築失敗:', e.message);
    if (!cache.photoIndex) { cache.photoIndex = []; await persist(); }
  }
}

// 写真専用ストアを永続化
async function persistPhotos() {
  if (!useRedis) {
    fs.writeFileSync(PHOTOS_FILE, JSON.stringify(photoCache), 'utf8');
  }
  // Redis は各 set/del 操作で個別に書き込むので不要
}

// 起動時マイグレーション：旧設計（メインblobのphotos/memo.img）を分離ストアへ移動
async function migratePhotosToSeparateStore() {
  let changed = false;
  // カレンダー写真（cache.photos）を分離
  if (cache.photos && Object.keys(cache.photos).length > 0) {
    for (const [date, img] of Object.entries(cache.photos)) {
      const field = `photo:${date}`;
      if (!photoCache[field]) {
        photoCache[field] = img;
        if (useRedis) await redis.hset(PHOTOS_KEY, { [field]: img });
      }
    }
    delete cache.photos;
    changed = true;
    console.log('[db] カレンダー写真をメインblobから分離しました');
  }
  // メモ内の img フィールドを分離（hasImg フラグに置換）
  for (const m of cache.memos || []) {
    if (m.img) {
      const field = `memo-img:${m.id}`;
      if (!photoCache[field]) {
        photoCache[field] = m.img;
        if (useRedis) await redis.hset(PHOTOS_KEY, { [field]: m.img });
      }
      m.hasImg = true;
      delete m.img;
      changed = true;
    }
  }
  if (changed) {
    await persist();
    await persistPhotos();
    console.log('[db] 写真マイグレーション完了');
  }
}

// 起動時マイグレーション：同 person × ticker の保有が複数あれば加重平均で1つに統合
async function mergeDuplicateHoldings() {
  if (!cache.holdings || cache.holdings.length === 0) return;
  const byKey = new Map(); // person|ticker -> consolidated entry
  const merged = [];
  for (const h of cache.holdings) {
    const key = `${h.person}|${h.ticker}`;
    const existing = byKey.get(key);
    if (existing) {
      const total = existing.shares + h.shares;
      // 両方コスト>0なら加重平均、片方だけならその値、両方0なら0のまま
      if (existing.cost > 0 && h.cost > 0 && total > 0) {
        existing.cost = (existing.shares * existing.cost + h.shares * h.cost) / total;
      } else if (h.cost > 0) {
        existing.cost = h.cost;
      }
      existing.shares = total;
      if (h.name && !existing.name) existing.name = h.name;
    } else {
      const copy = { ...h };
      byKey.set(key, copy);
      merged.push(copy);
    }
  }
  if (merged.length < cache.holdings.length) {
    const before = cache.holdings.length;
    cache.holdings = merged;
    await persist();
    console.log(`[db] 保有株の重複を統合: ${before} → ${merged.length} 件`);
  }
}

async function persist() {
  if (useRedis) {
    await redis.set(REDIS_KEY, cache);
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
  }
}

export async function saveShifts(person, shifts) {
  if (!shifts.length) return;

  const dateNums = shifts.map(s => s.year * 10000 + s.month * 100 + s.day);
  const lo = Math.min(...dateNums);
  const hi = Math.max(...dateNums);

  // この人の、同じ日付範囲の既存シフトを削除してから入れ直す
  cache.shifts = cache.shifts.filter(s => {
    if (s.person !== person) return true;
    const n = s.year * 10000 + s.month * 100 + s.day;
    return n < lo || n > hi;
  });

  for (const s of shifts) {
    cache.shifts.push({ ...s, person });
  }

  cache.shifts.sort((a, b) => {
    const an = a.year * 10000 + a.month * 100 + a.day;
    const bn = b.year * 10000 + b.month * 100 + b.day;
    return an !== bn ? an - bn : a.person.localeCompare(b.person);
  });

  cache.uploadLog[person] = new Date().toISOString();
  await persist();
}

export function getAllShifts() {
  return cache.shifts;
}

export function getUploadLog() {
  return cache.uploadLog;
}

// 1日・1人ぶんのシフトを手動で上書き（shift_type が 'none' なら削除）
export async function upsertShift(s) {
  const { person, year, month, day } = s;
  cache.shifts = cache.shifts.filter(
    x => !(x.person === person && x.year === year && x.month === month && x.day === day)
  );
  if (s.shift_type && s.shift_type !== 'none') {
    cache.shifts.push({
      year, month, day, person,
      shift_type: s.shift_type,
      start_time: s.start_time || null,
      end_time: s.end_time || null,
      label: s.label || null,
    });
  }
  cache.shifts.sort((a, b) => {
    const an = a.year * 10000 + a.month * 100 + a.day;
    const bn = b.year * 10000 + b.month * 100 + b.day;
    return an !== bn ? an - bn : a.person.localeCompare(b.person);
  });
  await persist();
}

export async function savePushSubscription(sub) {
  const json = JSON.stringify(sub);
  if (!cache.pushSubscriptions.some(s => JSON.stringify(s) === json)) {
    cache.pushSubscriptions.push(sub);
    await persist();
  }
}

export function getPushSubscriptions() {
  return cache.pushSubscriptions;
}

export async function saveAvatar(person, dataUrl) {
  if (!cache.avatars) cache.avatars = {};
  cache.avatars[person] = dataUrl;
  await persist();
}

export function getAvatars() {
  return cache.avatars || {};
}

// ── EVENTS（日に紐づく予定。2人共通）──
export function getEvents() {
  return cache.events || [];
}

export async function addEvent(ev) {
  if (!cache.events) cache.events = [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cache.events.push({
    id,
    year: ev.year, month: ev.month, day: ev.day,
    person: ['mine', 'hers'].includes(ev.person) ? ev.person : null,
    title: String(ev.title).slice(0, 100),
    time: ev.time || null,
    link: ev.link || null,
  });
  await persist();
  return id;
}

export async function deleteEvent(id) {
  if (!cache.events) return;
  cache.events = cache.events.filter(e => e.id !== id);
  await persist();
}

// ── WAGES（時給。1人ぶん）──
export function getWages() {
  return cache.wages || {};
}

export async function saveWage(person, wage) {
  if (!cache.wages) cache.wages = {};
  cache.wages[person] = Number(wage) || 0;
  await persist();
}

// ── LOCATIONS（居住地。天気表示用）──
export function getLocations() {
  return cache.locations || {};
}

export async function saveLocation(person, location) {
  if (!cache.locations) cache.locations = {};
  cache.locations[person] = String(location || '').slice(0, 60);
  await persist();
}

// ── EXPENSES（日ごとの出費。person別）──
export function getExpenses() {
  return cache.expenses || [];
}

export async function addExpense(ex) {
  if (!cache.expenses) cache.expenses = [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cache.expenses.push({
    id,
    year: ex.year, month: ex.month, day: ex.day,
    person: ['mine', 'hers'].includes(ex.person) ? ex.person : null,
    amount: Math.round(Number(ex.amount)) || 0,
    memo: String(ex.memo || '').slice(0, 60),
  });
  await persist();
  return id;
}

export async function deleteExpense(id) {
  if (!cache.expenses) return;
  cache.expenses = cache.expenses.filter(e => e.id !== id);
  await persist();
}

// ── GOOGLE CALENDAR 連携（限定公開iCal URL）──
export function getGcalUrls() {
  return cache.gcalUrls || {};
}

export async function saveGcalUrl(person, url) {
  if (!cache.gcalUrls) cache.gcalUrls = {};
  cache.gcalUrls[person] = String(url || '').trim().slice(0, 500);
  await persist();
}

// ── GOOGLE TASKS（OAuthリフレッシュトークン）──
export function getGtasksTokens() {
  return cache.gtasksTokens || {};
}

export async function saveGtasksToken(person, refreshToken) {
  if (!cache.gtasksTokens) cache.gtasksTokens = {};
  cache.gtasksTokens[person] = refreshToken;
  await persist();
}

export async function deleteGtasksToken(person) {
  if (!cache.gtasksTokens) return;
  delete cache.gtasksTokens[person];
  await persist();
}

// ── 保有株（手入力ポートフォリオ）──
export function getHoldings() {
  return cache.holdings || [];
}

export async function addHolding(h) {
  if (!cache.holdings) cache.holdings = [];
  let ticker = String(h.ticker || '').trim().toUpperCase().slice(0, 20);
  // 日本株の4〜5桁コードは自動で .T（東証）を付ける
  if (/^\d{4,5}$/.test(ticker)) ticker += '.T';
  const person = ['mine', 'hers'].includes(h.person) ? h.person : 'mine';
  const addShares = Number(h.shares) || 0;
  const addCost = Number(h.cost) || 0;
  // 価格付きの買いは取引履歴に記録（チャートに買いマーカーを出すため）
  if (addShares > 0 && addCost > 0) {
    if (!cache.buys) cache.buys = [];
    cache.buys.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      person, ticker, name: String(h.name || '').slice(0, 40),
      shares: addShares, price: addCost,
      currency: ticker.endsWith('.T') ? 'JPY' : 'USD',
      reason: String(h.reason || '').slice(0, 200) || null,
      ts: Date.now(),
    });
  }
  // 同じperson×tickerが既にあれば加算し、加重平均で取得単価を更新（2つに分かれて並ばないように）
  const existing = cache.holdings.find(x => x.person === person && x.ticker === ticker);
  if (existing) {
    const total = existing.shares + addShares;
    if (addCost > 0 && total > 0) {
      existing.cost = (existing.shares * existing.cost + addShares * addCost) / total;
    }
    existing.shares = total;
    if (h.name && !existing.name) existing.name = String(h.name).slice(0, 40);
    await persist();
    return existing.id;
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cache.holdings.push({
    id, person, ticker,
    shares: addShares,
    cost: addCost,
    name: String(h.name || '').slice(0, 40),
  });
  await persist();
  return id;
}

// 損切・利確の目標株価を設定（push通知用＋表示用）。値0/nullで解除。
export async function setHoldingTargets(id, { takeProfit, stopLoss, earningsDate }) {
  const h = (cache.holdings || []).find(x => x.id === id);
  if (!h) return false;
  const setOrClear = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  h.takeProfit = setOrClear(takeProfit);
  h.stopLoss = setOrClear(stopLoss);
  // 決算発表日（任意・手動入力）。YYYY-MM-DD のみ受け付け、それ以外は解除。
  if (earningsDate !== undefined) {
    h.earningsDate = /^\d{4}-\d{2}-\d{2}$/.test(earningsDate || '') ? earningsDate : null;
    h.earningsNotified = null; // 日付変更で通知済みフラグをリセット
  }
  h.targetsFired = {}; // 変更時に通知済みフラグをリセット
  await persist();
  return true;
}

export async function markHoldingEarningsNotified(id, dateKey) {
  const h = (cache.holdings || []).find(x => x.id === id);
  if (!h) return;
  h.earningsNotified = dateKey;
  await persist();
}

export async function markHoldingTargetFired(id, kind) {
  const h = (cache.holdings || []).find(x => x.id === id);
  if (!h) return;
  h.targetsFired = h.targetsFired || {};
  h.targetsFired[kind] = Date.now();
  await persist();
}

export function getBuys() {
  return cache.buys || [];
}

export async function sellHolding({ person, ticker, shares, sellPrice, currency, reason }) {
  if (!['mine','hers'].includes(person)) throw new Error('person が不正です');
  ticker = String(ticker || '').trim().toUpperCase();
  if (/^\d{4,5}$/.test(ticker)) ticker += '.T';
  const h = (cache.holdings || []).find(x => x.person === person && x.ticker === ticker);
  if (!h) throw new Error('該当する保有銘柄がありません');
  const soldShares = Number(shares) || 0;
  const px = Number(sellPrice) || 0;
  if (soldShares <= 0) throw new Error('売却株数が不正です');
  if (soldShares > h.shares) throw new Error(`保有数を超えています（保有 ${h.shares}株）`);
  if (px <= 0) throw new Error('売却単価が不正です');
  const cur = currency || (ticker.endsWith('.T') ? 'JPY' : 'USD');
  const realized = (px - h.cost) * soldShares;
  if (!cache.realized) cache.realized = [];
  const rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cache.realized.push({
    id: rid, person, ticker,
    name: h.name || '',
    shares: soldShares, sellPrice: px, costAtSale: h.cost,
    realized, currency: cur,
    reason: String(reason || '').slice(0, 200) || null,
    ts: Date.now(),
  });
  const remaining = h.shares - soldShares;
  const removed = remaining <= 0;
  if (removed) {
    cache.holdings = cache.holdings.filter(x => x.id !== h.id);
  } else {
    h.shares = remaining;
  }
  await persist();
  return { realized, costAtSale: h.cost, remaining: Math.max(0, remaining), removed, currency: cur, name: h.name || '', ticker };
}

export async function deleteHolding(id) {
  if (!cache.holdings) return;
  cache.holdings = cache.holdings.filter(h => h.id !== id);
  await persist();
}

// ── 実現損益（売却履歴）──
export function getRealized() {
  return cache.realized || [];
}

// ── BOARD（ふたりの掲示板：行きたい所・やりたいこと。日付に紐づかない共有メモ）──
export function getNotes() {
  return cache.notes || [];
}

export async function addNote(n) {
  if (!cache.notes) cache.notes = [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let link = n.link ? String(n.link).trim().slice(0, 500) : null;
  cache.notes.push({
    id,
    person: ['mine', 'hers'].includes(n.person) ? n.person : null, // null=ふたり
    text: String(n.text || '').slice(0, 200),
    link,
    done: false,
    createdAt: Date.now(),
  });
  await persist();
  return id;
}

export async function deleteNote(id) {
  if (!cache.notes) return;
  cache.notes = cache.notes.filter(n => n.id !== id);
  await persist();
}

export async function toggleNote(id) {
  if (!cache.notes) return;
  const n = cache.notes.find(x => x.id === id);
  if (n) { n.done = !n.done; await persist(); }
}

// ── MEMOS（ひろ/ちかそれぞれの個人メモ。person別に分離）──
export function getMemos() {
  // hasImg フラグがあればphotoCache から画像を注入して返す
  return (cache.memos || []).map(m => {
    if (!m.hasImg) return m;
    const img = photoCache[`memo-img:${m.id}`];
    return img ? { ...m, img } : m;
  });
}

export async function addMemo(m) {
  if (!cache.memos) cache.memos = [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const entry = {
    id,
    person: m.person === 'hers' ? 'hers' : 'mine',
    text: String(m.text || '').slice(0, 500),
    createdAt: Date.now(),
  };
  if (m.img) entry.hasImg = true; // 画像は分離ストアへ、フラグのみ本体に
  cache.memos.push(entry);
  if (m.img) {
    const field = `memo-img:${id}`;
    photoCache[field] = m.img;
    if (!cache.photoIndex) cache.photoIndex = [];
    if (!cache.photoIndex.some(e => e.field === field)) {
      cache.photoIndex.push({ field, person: entry.person || null, date: null });
    }
    if (useRedis) await redis.hset(PHOTOS_KEY, { [field]: m.img });
    else await persistPhotos();
  }
  await persist();
  return id;
}

export async function setMemoImage(id, img) {
  const m = (cache.memos || []).find(x => x.id === id);
  if (!m) return false;
  const field = `memo-img:${id}`;
  if (img) {
    photoCache[field] = img;
    m.hasImg = true;
    if (!cache.photoIndex) cache.photoIndex = [];
    if (!cache.photoIndex.some(e => e.field === field)) {
      cache.photoIndex.push({ field, person: m.person || null, date: null });
    }
    if (useRedis) await redis.hset(PHOTOS_KEY, { [field]: img });
    else await persistPhotos();
    await persist();
  } else {
    delete photoCache[field];
    delete m.hasImg;
    if (cache.photoIndex) cache.photoIndex = cache.photoIndex.filter(e => e.field !== field);
    if (useRedis) await redis.hdel(PHOTOS_KEY, field);
    else await persistPhotos();
    await persist();
  }
  return true;
}

export async function deleteMemo(id) {
  if (!cache.memos) return;
  cache.memos = cache.memos.filter(m => m.id !== id);
  // 写真も一緒に削除
  const field = `memo-img:${id}`;
  if (photoCache[field]) {
    delete photoCache[field];
    if (cache.photoIndex) cache.photoIndex = cache.photoIndex.filter(e => e.field !== field);
    if (useRedis) await redis.hdel(PHOTOS_KEY, field);
    else await persistPhotos();
  }
  await persist();
}

export async function editMemo(id, text) {
  if (!cache.memos) return false;
  const m = cache.memos.find(x => x.id === id);
  if (!m) return false;
  m.text = String(text || '').slice(0, 500);
  m.updatedAt = Date.now();
  await persist();
  return true;
}

// 起動時マイグレーション：photo:{date}（旧・1枚）→ photo:{date}:{id}（新・複数枚）
async function migratePhotoSingleToMulti() {
  const toMigrate = [];
  for (const k of Object.keys(photoCache)) {
    if (!k.startsWith('photo:')) continue;
    const rest = k.slice(6);
    if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) toMigrate.push(rest);
  }
  if (!toMigrate.length) return;
  for (const date of toMigrate) {
    const oldField = `photo:${date}`;
    const img = photoCache[oldField];
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const newField = `photo:${date}:${id}`;
    const value = JSON.stringify({ person: null, img });
    photoCache[newField] = value;
    delete photoCache[oldField];
    if (useRedis) {
      await redis.hset(PHOTOS_KEY, { [newField]: value });
      await redis.hdel(PHOTOS_KEY, oldField);
    }
  }
  if (!useRedis) await persistPhotos();
  console.log(`[db] 写真マイグレーション(1枚→複数): ${toMigrate.length}件`);
}

// ── カレンダー日別写真（複数枚・person付き）──
// 返り値: { 'YYYY-MM-DD': [{ id, person, img }] }
export function getPhotos() {
  const out = {};
  for (const [k, v] of Object.entries(photoCache)) {
    if (!k.startsWith('photo:')) continue;
    const rest = k.slice(6); // '{date}:{id}'
    const sep = rest.indexOf(':');
    if (sep === -1) continue; // 旧形式（migration済みでなければスキップ）
    const date = rest.slice(0, sep);
    const id = rest.slice(sep + 1);
    try {
      const entry = JSON.parse(v);
      if (!out[date]) out[date] = [];
      out[date].push({ id, person: entry.person || null, img: entry.img });
    } catch {}
  }
  return out;
}

export async function addPhoto(date, person, img) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const field = `photo:${date}:${id}`;
  const value = JSON.stringify({ person: person || null, img });
  photoCache[field] = value;
  // photoIndex を更新してメインblobに保存（起動時に個別 hget で参照するため）
  if (!cache.photoIndex) cache.photoIndex = [];
  if (!cache.photoIndex.some(e => e.field === field)) {
    cache.photoIndex.push({ field, person: person || null, date });
  }
  if (useRedis) {
    try { await redis.hset(PHOTOS_KEY, { [field]: value }); }
    catch (e) { console.error('[db] 写真保存失敗:', e.message); }
  } else await persistPhotos();
  await persist(); // photoIndex を永続化
  return id;
}

export async function deletePhoto(date, id) {
  const field = `photo:${date}:${id}`;
  if (!photoCache[field]) return false;
  delete photoCache[field];
  // photoIndex からも削除
  if (cache.photoIndex) cache.photoIndex = cache.photoIndex.filter(e => e.field !== field);
  if (useRedis) {
    try { await redis.hdel(PHOTOS_KEY, field); }
    catch (e) { console.error('[db] 写真削除失敗:', e.message); }
  } else await persistPhotos();
  await persist(); // photoIndex を永続化
  return true;
}

// ── 日記（AI生成テキストをdate単位で保存）──
export function getDiaries() { return cache.diaries || {}; }
export function getDiary(date) { return (cache.diaries || {})[date] || null; }
export async function setDiary(date, data) {
  if (!cache.diaries) cache.diaries = {};
  if (data) cache.diaries[date] = data;
  else delete cache.diaries[date];
  await persist();
}
export function getMonthlyDiaries() { return cache.monthlyDiaries || {}; }
export async function setMonthlyDiary(ym, data) {
  if (!cache.monthlyDiaries) cache.monthlyDiaries = {};
  if (data) cache.monthlyDiaries[ym] = data;
  else delete cache.monthlyDiaries[ym];
  await persist();
}

// ── 通知済みのふたり休み日（重複pushを防ぐ）──
export function getNotifiedOff() {
  return cache.notifiedOff || {};
}

export async function markNotifiedOff(dateKey) {
  if (!cache.notifiedOff) cache.notifiedOff = {};
  cache.notifiedOff[dateKey] = Date.now();
  await persist();
}

// ── 急騰・急落アラートの通知済み管理（同日同方向の重複通知を防ぐ。key=`YYYY-MM-DD:TICKER:up|down`）──
export function hasMoveAlert(key) {
  return !!(cache.moveAlerts && cache.moveAlerts[key]);
}

export async function markMoveAlert(key, todayKey) {
  if (!cache.moveAlerts) cache.moveAlerts = {};
  // 当日以外の古いキーは掃除（肥大化防止）
  for (const k of Object.keys(cache.moveAlerts)) {
    if (todayKey && !k.startsWith(todayKey + ':')) delete cache.moveAlerts[k];
  }
  cache.moveAlerts[key] = Date.now();
  await persist();
}

export function getGoals() {
  return cache.goals || [];
}

export async function addGoal({ title, amount, deadline, person }) {
  if (!cache.goals) cache.goals = [];
  const goal = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: String(title || '').slice(0, 60),
    amount: Math.round(Number(amount) || 0),
    deadline: deadline || null,
    person: person === 'hers' ? 'hers' : 'mine',
    createdAt: Date.now(),
  };
  cache.goals.push(goal);
  await persist();
  return goal;
}

export async function deleteGoal(id) {
  cache.goals = (cache.goals || []).filter(g => g.id !== id);
  await persist();
}

export function getTargetPrices() {
  return cache.targetPrices || [];
}

export async function addTargetPrice({ ticker, targetPrice, note, person }) {
  if (!cache.targetPrices) cache.targetPrices = [];
  const tp = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    ticker: String(ticker || '').toUpperCase().trim(),
    targetPrice: Number(targetPrice) || 0,
    note: String(note || '').slice(0, 100),
    person: person === 'hers' ? 'hers' : 'mine',
    createdAt: Date.now(),
  };
  cache.targetPrices.push(tp);
  await persist();
  return tp;
}

export async function deleteTargetPrice(id) {
  cache.targetPrices = (cache.targetPrices || []).filter(t => t.id !== id);
  await persist();
}
