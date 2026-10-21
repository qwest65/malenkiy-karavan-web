/*
 * Отзывы «Маленького каравана»: функция Яндекс Облака (Cloud Functions, Node.js 18+).
 *
 * 1. Сайт присылает сюда отзыв (POST {name, text}). Функция ничего не хранит, а пересылает
 *    его в Telegram модератору с кнопками «✅ Опубликовать» и «🗑 Удалить».
 * 2. Telegram присылает сюда нажатие кнопки (webhook). «Опубликовать» дописывает отзыв
 *    в data/reviews.json репозитория на GitHub — через минуту он на сайте у всех.
 *    У опубликованного остаётся кнопка «Снять с сайта».
 * 3. GET ?setup=1 один раз подключает бота к этой функции (setWebhook).
 *
 * Хранится только то, что человек сам написал: имя и текст. Ни почты, ни телефона, ни адреса.
 *
 * Переменные окружения функции:
 *   BOT_TOKEN      — токен бота от @BotFather
 *   ADMIN_CHAT_ID  — ваш chat id в Telegram (кому приходят отзывы)
 *   GITHUB_TOKEN   — токен GitHub с правом Contents: Read and write на репозиторий сайта
 *   HOOK_SECRET    — любая длинная случайная строка (защищает webhook от чужих запросов)
 *   REPO           — qwest65/malenkiy-karavan-web (по умолчанию)
 *   ALLOW_ORIGIN   — https://xn----7sbbaalryjidglrj8b2n.xn--p1ai (откуда разрешено присылать отзывы)
 *   WEBHOOK_URL    — адрес этой функции, если ?setup=1 не угадал его сам
 */
'use strict';

const REPO = process.env.REPO || 'qwest65/malenkiy-karavan-web';
const FILE = 'data/reviews.json';
const ORIGIN = process.env.ALLOW_ORIGIN || 'https://xn----7sbbaalryjidglrj8b2n.xn--p1ai';
const MAX_NAME = 40;
const MAX_TEXT = 1000;
// Не чаще одного отзыва в минуту с одного адреса — от случайных повторов и простого спама.
const recent = new Map();

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const reply = (statusCode, body, headers = {}) => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body),
});

function clean(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function github(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'malenkiy-karavan-reviews', 'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Меняет data/reviews.json; при одновременной правке повторяет. */
async function updateReviews(change, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await github('GET', `contents/${FILE}?ref=main`);
    const list = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    const next = change(list);
    const content = Buffer.from(JSON.stringify(next, null, 1) + '\n', 'utf8').toString('base64');
    try {
      return await github('PUT', `contents/${FILE}`, { message, content, sha: file.sha, branch: 'main' });
    } catch (e) {
      if (!/409|422/.test(e.message) || attempt === 2) throw e;
    }
  }
}

const card = (name, text) => `Имя: ${name}\n\n${text}`;

/** Имя и текст из сообщения модератору (оно и есть хранилище до публикации). */
function parseCard(msg) {
  const m = /Имя: (.*)\n\n([\s\S]*)$/.exec(msg.text || '');
  return m && { name: m[1].trim(), text: m[2].trim() };
}

async function newReview(event, headers) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  let data;
  try { data = JSON.parse(raw); } catch (_) { return reply(400, { error: 'bad json' }, cors); }
  if (data.website) return reply(200, { ok: true }, cors); // поле-ловушка для ботов
  const name = clean(data.name, MAX_NAME).replace(/\n/g, ' ');
  const text = clean(data.text, MAX_TEXT).replace(/\n{3,}/g, '\n\n');
  if (name.length < 2 || text.length < 5) return reply(400, { error: 'empty' }, cors);
  const ip = (headers['x-forwarded-for'] || event.requestContext?.identity?.sourceIp || '').split(',')[0].trim();
  const now = Date.now();
  if (ip && now - (recent.get(ip) || 0) < 60_000) return reply(429, { error: 'too often' }, cors);
  if (ip) recent.set(ip, now);
  await tg('sendMessage', {
    chat_id: process.env.ADMIN_CHAT_ID,
    text: `📝 Новый отзыв\n${card(name, text)}`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Опубликовать', callback_data: 'pub' }, { text: '🗑 Удалить', callback_data: 'del' },
    ]] },
  });
  return reply(200, { ok: true }, cors);
}

async function button(update) {
  const q = update.callback_query;
  if (!q || String(q.message?.chat?.id) !== String(process.env.ADMIN_CHAT_ID)) return reply(200, {});
  const msg = q.message;
  const review = parseCard(msg);
  const id = msg.message_id;
  const edit = (title, buttons) => tg('editMessageText', {
    chat_id: msg.chat.id, message_id: id, text: `${title}\n${card(review.name, review.text)}`,
    reply_markup: { inline_keyboard: buttons ? [buttons] : [] },
  });
  try {
    if (!review) throw new Error('не удалось прочитать отзыв');
    if (q.data === 'pub') {
      await updateReviews(list => [{ id, name: review.name, text: review.text, date: new Date().toISOString().slice(0, 10) },
        ...list.filter(r => r.id !== id)], `Отзыв: ${review.name}`);
      await edit('✅ Опубликован — через минуту будет на сайте', [{ text: '↩️ Снять с сайта', callback_data: 'unpub' }]);
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Опубликовано' });
    } else if (q.data === 'unpub') {
      await updateReviews(list => list.filter(r => r.id !== id), `Отзыв снят: ${review.name}`);
      await edit('↩️ Снят с сайта', [{ text: '✅ Опубликовать снова', callback_data: 'pub' }]);
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Снято с сайта' });
    } else if (q.data === 'del') {
      await edit('🗑 Удалён, на сайт не попал');
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Удалено' });
    }
  } catch (e) {
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: `Ошибка: ${e.message}`.slice(0, 190), show_alert: true });
  }
  return reply(200, {});
}

module.exports.handler = async (event, context) => {
  const method = event.httpMethod;
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'GET' && event.queryStringParameters?.setup === '1') {
    const url = process.env.WEBHOOK_URL || `https://functions.yandexcloud.net/${context.functionName}`;
    const result = await tg('setWebhook', { url, secret_token: process.env.HOOK_SECRET, allowed_updates: ['callback_query'] });
    return reply(200, { ok: result, webhook: url });
  }
  if (method !== 'POST') return reply(405, { error: 'POST only' });
  if (headers['x-telegram-bot-api-secret-token']) {
    if (headers['x-telegram-bot-api-secret-token'] !== process.env.HOOK_SECRET) return reply(403, {});
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return button(JSON.parse(raw));
  }
  return newReview(event, headers);
};
