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

export const getAll = (store) => run(store, 'readonly', (s) => done(s.getAll()));
export const get = (store, id) => run(store, 'readonly', (s) => done(s.get(id)));
export const put = (store, value) => run(store, 'readwrite', (s) => done(s.put(value)));
export const remove = (store, id) => run(store, 'readwrite', (s) => done(s.delete(id)));

export async function putMany(store, values) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  values.forEach((v) => s.put(v));
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function getMeta(key, fallback) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}
export const setMeta = (key, value) => put('meta', { key, value });
