import fs from 'fs';

const DB_FILE = 'data.json';

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { shifts: [], pushSubscriptions: [], uploadLog: {}, avatars: {} };
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

export function saveShifts(person, shifts) {
  if (!shifts.length) return;
  const data = load();

  const dateNums = shifts.map(s => s.year * 10000 + s.month * 100 + s.day);
  const lo = Math.min(...dateNums);
  const hi = Math.max(...dateNums);

  // Remove existing shifts for this person in the date range
  data.shifts = data.shifts.filter(s => {
    if (s.person !== person) return true;
    const n = s.year * 10000 + s.month * 100 + s.day;
    return n < lo || n > hi;
  });

  for (const s of shifts) {
    data.shifts.push({ ...s, person });
  }

  data.shifts.sort((a, b) => {
    const an = a.year * 10000 + a.month * 100 + a.day;
    const bn = b.year * 10000 + b.month * 100 + b.day;
    return an !== bn ? an - bn : a.person.localeCompare(b.person);
  });

  data.uploadLog[person] = new Date().toISOString();
  save(data);
}

export function getAllShifts() {
  return load().shifts;
}

export function getUploadLog() {
  return load().uploadLog;
}

export function savePushSubscription(sub) {
  const data = load();
  const json = JSON.stringify(sub);
  if (!data.pushSubscriptions.some(s => JSON.stringify(s) === json)) {
    data.pushSubscriptions.push(sub);
    save(data);
  }
}

export function getPushSubscriptions() {
  return load().pushSubscriptions;
}

export function saveAvatar(person, dataUrl) {
  const data = load();
  if (!data.avatars) data.avatars = {};
  data.avatars[person] = dataUrl;
  save(data);
}

export function getAvatars() {
  return load().avatars || {};
}
