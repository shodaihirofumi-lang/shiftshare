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

const empty = () => ({ shifts: [], pushSubscriptions: [], uploadLog: {}, avatars: {} });

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
