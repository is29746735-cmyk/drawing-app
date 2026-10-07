// 휴대폰 안 저장소(IndexedDB). 앱 전용 서랍장이라고 보면 된다.
// items  : 아이디어·자료 카드
// images : 사진 원본(full)과 작은 미리보기(thumb)
// meta   : 태그 목록 같은 설정
// inbox  : 다른 앱에서 "공유"로 넘어온 것 (sw.js가 넣는다)
const DB_NAME = 'drawing-box';
const DB_VERSION = 1;

let opening;
function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('items', { keyPath: 'id' });
        d.createObjectStore('images', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
        d.createObjectStore('inbox', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const d = req.result;
        // 서랍장 구조를 바꿔야 할 때(새 버전) 붙잡고 있지 않도록 놓아준다.
        d.onversionchange = () => {
          d.close();
          opening = null;
        };
        resolve(d);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error);
      };
    });
  }
  return opening;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function run(store, mode, fn) {
  const d = await open();
  const t = d.transaction(store, mode);
  const result = await fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

/* 인터넷 창고(sync.js)와 맞추기 위한 기록
   - 바뀐 것이 생기면 onChange로 알려준다.
   - 지운 것은 "지움 표시(tombstone)"로 남겨서 창고에서도 지우게 한다.
   - quiet: 창고에서 받아온 것을 넣을 때는 다시 알리지 않는다. */
const SYNCED_META = ['tags', 'boxes'];
let onChange = () => {};
export const setChangeListener = (fn) => { onChange = fn; };
function changed(store, key) {
  if (store === 'items' || store === 'images' || (store === 'meta' && SYNCED_META.includes(key))) onChange();
}

export const getAll = (store) => run(store, 'readonly', (s) => done(s.getAll()));
export const get = (store, id) => run(store, 'readonly', (s) => done(s.get(id)));

export async function put(store, value, { quiet = false } = {}) {
  const result = await run(store, 'readwrite', (s) => done(s.put(value)));
  if (!quiet) changed(store, value.key);
  return result;
}

export async function remove(store, id, { quiet = false } = {}) {
  await run(store, 'readwrite', (s) => done(s.delete(id)));
  if (quiet || (store !== 'items' && store !== 'images')) return;
  const marks = await getMeta('_tombstones', {});
  marks[`${store}:${id}`] = Date.now();
  await setMeta('_tombstones', marks);
  changed(store);
}

export async function putMany(store, values, { quiet = false } = {}) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  values.forEach((v) => s.put(v));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  if (!quiet && values.length) changed(store, values[0].key);
}

export async function getMeta(key, fallback) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}
// updatedAt: 언제 바꿨는지. 창고와 비교해서 더 최근 것을 남긴다.
export const setMeta = (key, value, updatedAt = Date.now(), opts) =>
  put('meta', { key, value, updatedAt }, opts);
