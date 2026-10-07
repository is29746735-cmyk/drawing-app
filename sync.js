// 인터넷 창고(Turso)와 폰 안 서랍장을 맞춘다.
// - 폰 안 서랍장이 먼저다. 인터넷이 없어도 앱은 그대로 쓴다.
// - 연결되어 있으면 바뀐 것을 창고로 올리고, 창고에만 있는 것은 받아온다.
// - 같은 것을 양쪽에서 고쳤으면 더 나중에 고친 쪽을 남긴다.
// 주소와 토큰(열쇠)은 이 폰의 localStorage에만 둔다. 코드에는 넣지 않는다.
import * as db from './db.js';

const SETTINGS_KEY = 'turso';
const SYNCED_META = ['tags', 'boxes'];

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || null;
  } catch {
    return null;
  }
}
export function saveSettings(settings) {
  if (settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  else localStorage.removeItem(SETTINGS_KEY);
}

// libsql://이름.turso.io → https://이름.turso.io
const httpUrl = (url) => url.trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');

/* ---------- Turso에 SQL 보내기 (HTTP pipeline 방식) ---------- */

function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'integer', value: String(Math.round(v)) };
  return { type: 'text', value: String(v) };
}
function decodeValue(v) {
  if (v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'blob') return v.base64;
  return v.value;
}

// stmts: [{ sql, args }]  →  결과: 문장마다 행 목록 [{열이름: 값}]
async function query(settings, stmts) {
  const res = await fetch(`${httpUrl(settings.url)}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        ...stmts.map((s) => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args || []).map(encodeArg) } })),
        { type: 'close' },
      ],
    }),
  });
  if (res.status === 401 || res.status === 403) throw new SyncError('auth');
  if (!res.ok) throw new SyncError('server', `HTTP ${res.status}`);
  const data = await res.json();
  return data.results.slice(0, stmts.length).map((r) => {
    if (r.type === 'error') throw new SyncError('server', r.error?.message);
    const { cols, rows } = r.response.result;
    return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, decodeValue(row[i])])));
  });
}

export class SyncError extends Error {
  constructor(kind, detail = '') {
    super(`${kind} ${detail}`);
    this.kind = kind; // auth | server | network
  }
}

const SCHEMA = [
  { sql: 'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER, deleted INTEGER DEFAULT 0)' },
  { sql: 'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, full TEXT, thumb TEXT, deleted INTEGER DEFAULT 0)' },
  { sql: 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)' },
];

// 연결 확인: 주소·토큰이 맞는지 보고, 표가 없으면 만든다.
export async function testConnection(settings) {
  try {
    await query(settings, SCHEMA);
  } catch (e) {
    throw e instanceof SyncError ? e : new SyncError('network', e.message);
  }
}

/* ---------- 사진 ↔ 글자(base64) ---------- */

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

/* ---------- 맞추기 ---------- */

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

const UPSERT_ITEM = 'INSERT INTO items (id, data, updated_at, deleted) VALUES (?, ?, ?, ?) '
  + 'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted';
const UPSERT_IMAGE = 'INSERT INTO images (id, full, thumb, deleted) VALUES (?, ?, ?, ?) '
  + 'ON CONFLICT(id) DO UPDATE SET full = excluded.full, thumb = excluded.thumb, deleted = excluded.deleted';
const UPSERT_META = 'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) '
  + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';

// 한 번 맞추기. 받아온 것이 있으면 true를 돌려준다(화면을 다시 그려야 함).
async function syncOnce(settings, progress) {
  const [remoteItems, remoteImages, remoteMeta] = await query(settings, [
    { sql: 'SELECT id, updated_at, deleted FROM items' },
    { sql: 'SELECT id, deleted FROM images' },
    { sql: 'SELECT key, value, updated_at FROM meta' },
  ]);
  const rItems = new Map(remoteItems.map((r) => [r.id, r]));
  const rImages = new Map(remoteImages.map((r) => [r.id, r]));
  const rMeta = new Map(remoteMeta.map((r) => [r.key, r]));

  const marks = await db.getMeta('_tombstones', {});
  const localItems = await db.getAll('items');
  const lItems = new Map(localItems.map((i) => [i.id, i]));
  const localImageIds = new Set((await db.getAll('images')).map((i) => i.id));
  let pulled = false;

  // 1) 지움 표시 올리기
  const doneMarks = [];
  const markStmts = [];
  for (const [key, at] of Object.entries(marks)) {
    const [store, id] = key.split(':');
    if (store === 'items') markStmts.push({ sql: UPSERT_ITEM, args: [id, null, at, 1] });
    else markStmts.push({ sql: UPSERT_IMAGE, args: [id, null, null, 1] });
    doneMarks.push(key);
  }
  for (const part of chunk(markStmts, 50)) await query(settings, part);

  // 2) 카드(아이디어·자료): 더 최근 쪽으로 맞춘다
  const pushItems = localItems.filter((i) => {
    const r = rItems.get(i.id);
    return !r || (i.updatedAt || 0) > r.updated_at;
  });
  for (const part of chunk(pushItems, 50)) {
    await query(settings, part.map((i) => ({ sql: UPSERT_ITEM, args: [i.id, JSON.stringify(i), i.updatedAt || 0, 0] })));
  }

  const pullIds = [];
  for (const r of remoteItems) {
    const local = lItems.get(r.id);
    if (marks[`items:${r.id}`]) continue;
    if (r.deleted) {
      if (local && (local.updatedAt || 0) <= r.updated_at) {
        await db.remove('items', r.id, { quiet: true });
        pulled = true;
      }
    } else if (!local || r.updated_at > (local.updatedAt || 0)) {
      pullIds.push(r.id);
    }
  }
  for (const part of chunk(pullIds, 100)) {
    const [rows] = await query(settings, [
      { sql: `SELECT data FROM items WHERE id IN (${part.map(() => '?').join(',')})`, args: part },
    ]);
    await db.putMany('items', rows.map((r) => JSON.parse(r.data)), { quiet: true });
    pulled = true;
  }

  // 3) 사진: 없는 쪽으로 옮긴다 (사진은 한 번 저장하면 바뀌지 않는다)
  const upImages = [...localImageIds].filter((id) => !rImages.has(id));
  const downImages = [...rImages.values()]
    .filter((r) => !r.deleted && !localImageIds.has(r.id) && !marks[`images:${r.id}`])
    .map((r) => r.id);
  const total = upImages.length + downImages.length;
  let count = 0;

  for (const id of upImages) {
    progress?.(++count, total);
    const im = await db.get('images', id);
    if (!im) continue;
    await query(settings, [{ sql: UPSERT_IMAGE, args: [id, await blobToBase64(im.full), await blobToBase64(im.thumb), 0] }]);
  }
  for (const part of chunk(downImages, 3)) {
    progress?.((count += part.length), total);
    const [rows] = await query(settings, [
      { sql: `SELECT id, full, thumb FROM images WHERE id IN (${part.map(() => '?').join(',')})`, args: part },
    ]);
    await db.putMany('images', rows.map((r) => ({ id: r.id, full: base64ToBlob(r.full), thumb: base64ToBlob(r.thumb) })), { quiet: true });
    pulled = true;
  }
  for (const r of remoteImages) {
    if (r.deleted && localImageIds.has(r.id)) {
      await db.remove('images', r.id, { quiet: true });
      pulled = true;
    }
  }

  // 4) 태그·보관함 목록
  for (const key of SYNCED_META) {
    const row = await db.get('meta', key);
    const r = rMeta.get(key);
    const localAt = row?.updatedAt || 0;
    if (row && (!r || localAt > r.updated_at)) {
      await query(settings, [{ sql: UPSERT_META, args: [key, JSON.stringify(row.value), localAt] }]);
    } else if (r && r.updated_at > localAt) {
      await db.setMeta(key, JSON.parse(r.value), r.updated_at, { quiet: true });
      pulled = true;
    }
  }

  // 올린 지움 표시는 정리한다 (그 사이 새로 생긴 표시는 남긴다)
  const now = await db.getMeta('_tombstones', {});
  doneMarks.forEach((k) => delete now[k]);
  await db.setMeta('_tombstones', now);

  return pulled;
}

/* ---------- 언제 맞출지 ---------- */

let running = null;
let again = false;
let timer;
let listener = () => {};

// status: { state: 'off' | 'syncing' | 'ok' | 'error', at?, error?, progress? }
export const status = { state: 'off' };
function setStatus(next) {
  Object.assign(status, next);
  listener(status);
}

export function start({ onPulled, onStatus }) {
  listener = onStatus;
  db.setChangeListener(() => schedule(3000));
  window.addEventListener('online', () => schedule(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(0);
  });
  start.onPulled = onPulled;
  if (getSettings()) setStatus({ state: 'ok', at: Number(localStorage.getItem('turso-at')) || null });
  schedule(0);
}

export function schedule(delay) {
  clearTimeout(timer);
  if (!getSettings()) {
    setStatus({ state: 'off', error: null });
    return;
  }
  timer = setTimeout(syncNow, delay);
}

export async function syncNow() {
  const settings = getSettings();
  if (!settings) return;
  if (running) {
    again = true;
    return running;
  }
  if (!navigator.onLine) {
    setStatus({ state: 'error', error: 'offline' });
    return;
  }
  running = (async () => {
    setStatus({ state: 'syncing', error: null, progress: null });
    try {
      const pulled = await syncOnce(settings, (n, total) => setStatus({ progress: { n, total } }));
      const at = Date.now();
      localStorage.setItem('turso-at', String(at));
      setStatus({ state: 'ok', at, progress: null });
      if (pulled) await start.onPulled?.();
    } catch (e) {
      console.error(e);
      setStatus({ state: 'error', error: e instanceof SyncError ? e.kind : 'network', progress: null });
    } finally {
      running = null;
      if (again) {
        again = false;
        schedule(500);
      }
    }
  })();
  return running;
}
