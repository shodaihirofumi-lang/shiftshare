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

const empty = () => ({ shifts: [], pushSubscriptions: [], uploadLog: {}, avatars: {}, events: [], wages: {}, locations: {}, expenses: [], gcalUrls: {} });

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
