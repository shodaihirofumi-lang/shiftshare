import fs from 'fs';
import { Redis } from '@upstash/redis';

const DB_FILE = 'data.json';
const REDIS_KEY = 'shiftshare:data';

// Upstash Redis を使うのは環境変数が両方ある時だけ。
// 無ければローカルファイル(data.json)にフォールバック（ローカル開発用）。
const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = useRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

const empty = () => ({ shifts: [], pushSubscriptions: [], uploadLog: {}, avatars: {}, events: [], wages: {}, locations: {}, expenses: [], gcalUrls: {}, gtasksTokens: {}, holdings: [], notes: [], memos: [], notifiedOff: {}, realized: [], buys: [] });

// 全データをメモリにキャッシュ。読み取りは同期、書き込み時に永続化。
let cache = empty();

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
  await mergeDuplicateHoldings();
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
export async function setHoldingTargets(id, { takeProfit, stopLoss }) {
  const h = (cache.holdings || []).find(x => x.id === id);
  if (!h) return false;
  const setOrClear = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  h.takeProfit = setOrClear(takeProfit);
  h.stopLoss = setOrClear(stopLoss);
  h.targetsFired = {}; // 変更時に通知済みフラグをリセット
  await persist();
  return true;
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

export async function sellHolding({ person, ticker, shares, sellPrice, currency }) {
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
    realized, currency: cur, ts: Date.now(),
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
  return cache.memos || [];
}

export async function addMemo(m) {
  if (!cache.memos) cache.memos = [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cache.memos.push({
    id,
    person: m.person === 'hers' ? 'hers' : 'mine',
    text: String(m.text || '').slice(0, 500),
    createdAt: Date.now(),
  });
  await persist();
  return id;
}

export async function deleteMemo(id) {
  if (!cache.memos) return;
  cache.memos = cache.memos.filter(m => m.id !== id);
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

// ── 通知済みのふたり休み日（重複pushを防ぐ）──
export function getNotifiedOff() {
  return cache.notifiedOff || {};
}

export async function markNotifiedOff(dateKey) {
  if (!cache.notifiedOff) cache.notifiedOff = {};
  cache.notifiedOff[dateKey] = Date.now();
  await persist();
}
