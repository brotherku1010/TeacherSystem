const CACHE_NAME = 'teacher-pwa-shell-v10';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './config.js',
  './app.js',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // 師資資料與 GAS iframe 一律走網路，不寫入裝置快取。
  if (url.origin !== self.location.origin) return;

  const isMutableShellFile = /\/(?:index\.html|app\.js|config\.js|manifest\.webmanifest)$/i.test(url.pathname);
  if (request.mode === 'navigate' || isMutableShellFile) {
    // 授權邏輯與設定優先使用網路新版；離線時才退回快取，避免桌面端卡在舊版登入流程。
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
