/*
 * Работа без интернета: при первом открытии всё приложение — тексты, наклейки и озвучка —
 * сохраняется в телефоне. Кусочки карты запоминаются по мере просмотра.
 * После любых правок увеличьте VERSION, чтобы телефоны забрали новую версию.
 */
const VERSION = 'v1';
const APP_CACHE = `karavan-app-${VERSION}`;
const MAP_CACHE = 'karavan-map';
const SHELL = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'data/route.json', 'data/paths.json', 'data/streets.json', 'data/files.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.png', 'images/og.png',
];

/** Safari просит озвучку кусками (Range) и без ответа 206 не играет её из памяти. */
async function partial(response, range) {
  const body = await response.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const size = body.byteLength;
  let start = m && m[1] ? +m[1] : 0;
  let end = m && m[2] ? +m[2] : size - 1;
  if (m && !m[1] && m[2]) { start = size - +m[2]; end = size - 1; }
  end = Math.min(end, size - 1);
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(SHELL);
    const files = await (await fetch('data/files.json')).json();
    await cache.addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('karavan-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Карта и шрифты: сначала из памяти телефона, а если нет — из интернета с сохранением.
  if (url.hostname.endsWith('openfreemap.org') || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_CACHE);
      const hit = await cache.match(req);
      const net = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      if (hit) {
        event.waitUntil(net.catch(() => null));
        return hit;
      }
      return net;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;
  // Свои файлы: из памяти телефона; новая версия приходит вместе с новым VERSION.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit && req.headers.has('range')) return partial(hit, req.headers.get('range'));
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') return caches.match('index.html');
      throw e;
    }
  })());
});
