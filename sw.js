// 서비스 워커: 앱 뒤에서 일하는 도우미.
// 1) 앱 파일을 저장해 두어 인터넷이 없어도 열리게 한다.
// 2) 다른 앱에서 "공유 → 보관함"으로 보낸 사진·글을 받아 inbox에 넣는다.
const CACHE = 'box-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' = 저장해 둔 옛 파일 말고 서버에서 새로 받기
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;

  // 글꼴: 한 번 받으면 저장해 두고 계속 쓴다.
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })),
    );
    return;
  }

  // 앱 파일: 새 버전을 먼저 받아보고, 인터넷이 없으면 저장본을 쓴다.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request.url, { cache: 'no-cache' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true })),
    );
  }
});

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('images').filter((f) => f && f.size);
  const text = ['title', 'text', 'url']
    .map((k) => form.get(k))
    .filter(Boolean)
    .join('\n');

  await putInbox({ id: 'share', files, text, at: Date.now() });
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

// db.js와 같은 서랍장을 연다 (서비스 워커는 db.js를 불러올 수 없어서 따로 둔다).
function putInbox(value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('drawing-box', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('items', { keyPath: 'id' });
      d.createObjectStore('images', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'key' });
      d.createObjectStore('inbox', { keyPath: 'id' });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const d = req.result;
      const t = d.transaction('inbox', 'readwrite');
      t.objectStore('inbox').put(value);
      t.oncomplete = () => {
        d.close();
        resolve();
      };
      t.onerror = () => {
        d.close();
        reject(t.error);
      };
    };
  });
}
