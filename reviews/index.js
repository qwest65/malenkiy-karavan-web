/*
 * Отзывы «Маленького каравана»: функция Яндекс Облака (Cloud Functions, Node.js 18+).
 *
 * Сайт присылает сюда отзыв (POST {name, text, rating}). Функция ничего не хранит, а создаёт задачу (Issue)
 * в закрытом репозитории отзывов на GitHub: заголовок «Отзыв: имя», внутри оценка и текст. GitHub присылает
 * модераторам пуш. Закрыли задачу как выполненную — workflow в том репозитории (moderation.yml)
 * публикует отзыв в data/reviews.json сайта; закрыли как «not planned» — отзыв не публикуется;
 * открыли снова — снимается с сайта.
 *
 * Хранится только то, что человек сам написал: имя, оценка и текст. Ни почты, ни телефона, ни адреса.
 *
 * GET ?check=1 — самопроверка: видит ли функция репозиторий отзывов и задан ли токен.
 *
 * Переменные окружения функции:
 *   GITHUB_TOKEN   — токен GitHub с правом Issues: Read and write на репозиторий отзывов
 *   REVIEWS_REPO   — закрытый репозиторий отзывов (по умолчанию qwest65/malenkiy-karavan-otzyvy)
 *   ALLOW_ORIGIN   — откуда разрешено присылать отзывы, через запятую (по умолчанию маленький-караван.рф
 *                    и malenkiy-karavan.ru, с www и без; кириллический адрес — латиницей, xn--…)
 */
'use strict';

const REPO = process.env.REVIEWS_REPO || 'qwest65/malenkiy-karavan-otzyvy';
const ORIGINS = (process.env.ALLOW_ORIGIN ||
  'https://xn----7sbbaalryjidglrj8b2n.xn--p1ai,https://www.xn----7sbbaalryjidglrj8b2n.xn--p1ai,' +
  'https://malenkiy-karavan.ru,https://www.malenkiy-karavan.ru').split(',').map(o => o.trim()).filter(Boolean);
const MAX_NAME = 40;
const MAX_TEXT = 1000;
const NET_MS = 5000;
// Не чаще одного отзыва в минуту с одного адреса — от случайных повторов и простого спама.
const recent = new Map();

// Браузер пускает ответ, только если в нём назван адрес страницы, — отвечаем тем из разрешённых, откуда пришли.
const corsFor = (origin) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
});
const reply = (statusCode, body, headers = {}) => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body),
});

function clean(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

async function github(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'malenkiy-karavan-reviews', 'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(NET_MS),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function newReview(event, headers, cors) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  let data;
  try { data = JSON.parse(raw); } catch (_) { return reply(400, { error: 'bad json' }, cors); }
  if (data.website) return reply(200, { ok: true }, cors); // поле-ловушка для ботов
  const name = clean(data.name, MAX_NAME).replace(/\n/g, ' ');
  const text = clean(data.text, MAX_TEXT).replace(/\n{3,}/g, '\n\n');
  if (name.length < 2 || text.length < 5) return reply(400, { error: 'empty' }, cors);
  const rating = Number.isInteger(data.rating) && data.rating >= 1 && data.rating <= 5 ? data.rating : 0;
  const ip = (headers['x-forwarded-for'] || event.requestContext?.identity?.sourceIp || '').split(',')[0].trim();
  const now = Date.now();
  if (ip && now - (recent.get(ip) || 0) < 60_000) return reply(429, { error: 'too often' }, cors);
  if (ip) recent.set(ip, now);
  // Первая строка — оценка: её читает moderation.yml; модератор видит звёзды прямо в задаче.
  const stars = rating ? `Оценка: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating} из 5)\n\n` : '';
  await github('POST', '/issues', { title: `Отзыв: ${name}`, body: stars + text });
  return reply(200, { ok: true }, cors);
}

module.exports.handler = async (event) => {
  const method = event.httpMethod;
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const cors = corsFor(headers.origin);
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (method === 'GET' && event.queryStringParameters?.check === '1') {
    try {
      if (!process.env.GITHUB_TOKEN) throw new Error('не задан GITHUB_TOKEN');
      const repo = await github('GET', '');
      return reply(200, { github: `ok: ${repo.full_name}${repo.private ? ' (закрытый)' : ' — ВНИМАНИЕ: репозиторий открытый!'}` });
    } catch (e) {
      return reply(200, { github: `ошибка: ${e.name === 'TimeoutError' ? 'нет ответа за 5 с' : e.message}` });
    }
  }
  if (method !== 'POST') return reply(405, { error: 'POST only' });
  try {
    return await newReview(event, headers, cors);
  } catch (e) {
    console.error(e);
    return reply(502, { error: 'не удалось сохранить отзыв' }, cors);
  }
};
