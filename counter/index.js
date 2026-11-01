/*
 * Счётчик запусков «Маленького каравана»: функция Яндекс Облака (Cloud Functions, Node.js 18+).
 *
 * Прогулка присылает сюда событие GET ?e=open | start | finish | install (открыли, начали прогулку,
 * дошли до конца, поставили на экран «Домой»). Функция кладёт в хранилище (Object Storage) один пустой
 * файл «день/событие/номер» — и всё. Ничего о человеке не передаётся и не хранится: ни имени, ни адреса,
 * ни номера. Раз в сутки GitHub (workflow Stats) считает файлы и записывает сводку в ветку stats.
 *
 * GET ?check=1 — самопроверка: задано ли хранилище и выдал ли Яндекс функции токен.
 * GET ?e=open&debug=1 — то же событие, но ответ покажет, что ответило хранилище (только если DEBUG=1).
 *
 * Переменные окружения функции:
 *   BUCKET        — имя бакета Object Storage
 *   ALLOW_ORIGIN  — откуда принимать события, через запятую (по умолчанию как у отзывов)
 *   DEBUG         — 1 включает ?debug=1 на время настройки
 * Функции нужен сервисный аккаунт с ролью storage.uploader на бакет: токен функция получает сама.
 */
'use strict';

const BUCKET = process.env.BUCKET;
const ORIGINS = (process.env.ALLOW_ORIGIN ||
  'https://xn----7sbbaalryjidglrj8b2n.xn--p1ai,https://www.xn----7sbbaalryjidglrj8b2n.xn--p1ai,' +
  'https://malenkiy-karavan.ru,https://www.malenkiy-karavan.ru').split(',').map(o => o.trim()).filter(Boolean);
const EVENTS = new Set(['open', 'start', 'finish', 'install']);
const NET_MS = 4000;

const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});
const header = (event, name) => {
  const h = event.headers || {};
  const key = Object.keys(h).find(k => k.toLowerCase() === name);
  return key ? String(h[key]) : '';
};

// День по московскому времени: по нему считаются сводки.
const day = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

module.exports.handler = async (event, context) => {
  const q = event.queryStringParameters || {};
  const token = context && context.token && context.token.access_token;
  if (q.check) return json(200, { bucket: !!BUCKET, token: !!token });

  // Откуда пришёл запрос: страница нашего сайта. Чужие и выдуманные события не считаем.
  const from = header(event, 'origin') || header(event, 'referer');
  const ok = EVENTS.has(q.e) && (!from || ORIGINS.some(o => from.startsWith(o)));
  let status = 'skipped';
  if (ok && BUCKET && token) {
    const key = `${day()}/${q.e}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      const r = await fetch(`https://storage.yandexcloud.net/${BUCKET}/${key}`, {
        method: 'PUT', headers: { 'X-YaCloud-SubjectToken': token }, body: '', signal: AbortSignal.timeout(NET_MS),
      });
      status = r.ok ? 'stored' : `storage ${r.status} ${(await r.text()).slice(0, 200)}`;
      if (!r.ok) console.error(status);
    } catch (e) {
      status = `error ${e.message}`; console.error(status);
    }
  }
  if (q.debug && process.env.DEBUG === '1') return json(200, { status });
  return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
};
