/*
 * Работа без интернета: при первом открытии всё приложение — тексты, наклейки и озвучка —
 * сохраняется в телефоне, вместе со своей картой Троицка (папка map/).
 * После любых правок увеличьте VERSION, чтобы телефоны забрали новую версию.
 */
const VERSION = 'v24';
// Своя приставка: на том же адресе qwest65.github.io раньше жила старая копия (karavan-app-…).
const APP_CACHE = `karavan-web-${VERSION}`;
const FONT_CACHE = 'karavan-fonts';
// Прежний кэш подложки с чужого сервера карт — больше не нужен.
const OLD_MAP_CACHE = 'karavan-map';
const SHELL = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  // Общие с сайтом проекта файлы лежат на уровень выше, в корне.
  '../vendor/maplibre-gl.js', '../vendor/maplibre-gl.css',
  '../data/route.json', '../data/paths.json', '../data/streets.json', '../data/files.json',
  '../icons/icon-192.png', '../icons/icon-512.png', '../icons/apple-touch-icon.png', '../icons/favicon.png', '../images/og.jpg',
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

/** Сколько файлов уже сохранено — открытые страницы показывают это полоской на главном экране. */
async function notify(done, total) {
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    c.postMessage({ type: 'offline-progress', done, total });
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    const files = (await (await fetch('../data/files.json', { cache: 'reload' })).json()).map(f => `../${f}`);
    const all = [...SHELL, ...files];
    const queue = all.slice();
    let done = 0;
    await notify(0, all.length);
    // По одному файлу в шесть потоков, чтобы считать проценты. Мимо кэша браузера: GitHub Pages
    // разрешает держать файлы 10 минут, и без этого в новую версию мог попасть старый app.js.
    const worker = async () => {
      while (queue.length) {
        await cache.add(new Request(queue.shift(), { cache: 'reload' }));
        await notify(++done, all.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if ((key.startsWith('karavan-web-') && key !== APP_CACHE) || key === OLD_MAP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Шрифт Rubik: сначала из памяти телефона, а если нет — из интернета с сохранением.
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
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
