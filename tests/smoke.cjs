/*
 * Проверка в настоящем браузере перед выкладкой: прогулка открывается, маршрут стартует,
 * панель сворачивается, точка открывается, коллаж и грамота собираются на лист A4,
 * сайт проекта грузится целиком. Внешние сервисы (подложка карты, шрифты) отключены,
 * чтобы проверка не зависела от интернета.
 *
 *   npm install --no-save playwright && npx playwright install chromium
 *   node tests/smoke.cjs
 */
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8790;
const BASE = `http://localhost:${PORT}/`;
const WALK = BASE + 'progulka/';
const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const first = (await (await browser.newContext()).newPage());
    await first.goto(WALK);
    const firstStop = await first.evaluate(async () => {
      const r = await (await fetch('../data/route.json')).json();
      return r.stops[r.default_order[0]];
    });

    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true,
      geolocation: { latitude: firstStop.lat + 0.004, longitude: firstStop.lon }, permissions: ['geolocation'],
    });
    await ctx.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

    // Главный экран
    await page.goto(WALK);
    await page.waitForSelector('[data-act="choose"], [data-act="resume"]', { timeout: 10000 });
    const version = await page.evaluate(() => APP_VERSION);
    check(await page.isVisible(`text=Веб-версия ${version}`), `главный экран открылся, версия ${version}`);

    // Прогулка: старт, расстояние до точки, автосворачивание панели
    await page.evaluate(() => startWalk(route.presets[0].stops));
    await page.waitForSelector('#walk-panel .target');
    check(await page.evaluate(() => S.screen === 'walk'), 'прогулка началась');
    await page.waitForFunction(() => S.distance != null, null, { timeout: 10000 }).catch(() => {});
    check(await page.evaluate(() => S.distance != null && S.distance > 0), 'расстояние до первой точки посчитано по GPS');
    await page.waitForTimeout(5600);
    check(await page.evaluate(() => !document.querySelector('#walk-panel .target')), 'нижняя панель свернулась через 5 секунд');

    // Точка: «Мы на месте!» открывает экран точки
    await page.evaluate(() => arrive());
    await page.waitForTimeout(3500);
    check(await page.evaluate(() => S.screen === 'stop'), '«Мы на месте!» открывает экран точки');

    // Коллаж: лист A4 при любом числе находок
    const sizes = await page.evaluate(async () => {
      Photos.url = () => '../images/og.jpg';
      const out = [];
      for (const n of [1, 2, 5, 9]) {
        const img = await createImageBitmap(await renderCollage(route.default_order.slice(0, n), n === 9));
        out.push(`${img.width}x${img.height}`);
      }
      return out;
    });
    check(sizes.every(s => s === '1654x2339'), `коллаж — лист A4 (${sizes.join(', ')})`);

    // Грамота (если уже есть в этой версии)
    if (await page.evaluate(() => typeof renderDiploma === 'function')) {
      const d = await page.evaluate(async () => {
        const img = await createImageBitmap(await renderDiploma('Маша Сердюкова', route.default_order, new Date()));
        return `${img.width}x${img.height}`;
      });
      check(d === '1654x2339', `грамота — лист A4 (${d})`);
    }

    // Грамота: финальный экран → имя → грамота; в альбоме её можно исправить
    if (await page.evaluate(() => typeof renderDiploma === 'function')) {
      await page.evaluate(() => {
        setJourney({ ...S.journey, found: route.default_order.slice(), badge: true });
        S.result = { complete: true, found: route.default_order.slice() };
        go('finale');
      });
      await page.fill('#child-name', 'Маша Сердюкова');
      await page.click('[data-act="diploma"]');
      await page.waitForSelector('img[alt^="Грамота"]', { timeout: 10000 }).catch(() => {});
      check(await page.isVisible('img[alt^="Грамота: Маша Сердюкова"]'), 'на финальном экране грамота с введённым именем');
      await page.evaluate(() => go('album'));
      await page.click('[data-act="editName"]');
      await page.fill('#child-name', 'Маша Иванова');
      await page.click('[data-act="diploma"]');
      await page.waitForSelector('img[alt^="Грамота: Маша Иванова"]', { timeout: 10000 }).catch(() => {});
      check(await page.isVisible('img[alt^="Грамота: Маша Иванова"]'), 'в альбоме имя на грамоте можно исправить');
    }

    check(errors.length === 0, `прогулка без ошибок${errors.length ? ': ' + errors.join('; ') : ''}`);

    // Сайт проекта
    const site = await (await browser.newContext({ viewport: { width: 1366, height: 800 } })).newPage();
    const siteErrors = [];
    await site.context().route(/^https?:\/\/(?!localhost)/, r => r.abort());
    site.on('pageerror', e => siteErrors.push(e.message));
    site.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) siteErrors.push(`${r.status()} ${r.url()}`); });
    await site.goto(BASE);
    await site.waitForLoadState('load');
    await site.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 20)); } });
    const broken = await site.evaluate(() => [...document.images].filter(i => i.complete && !i.naturalWidth).map(i => i.getAttribute('src')));
    check(broken.length === 0, `на сайте все картинки на месте${broken.length ? ': ' + broken.join(', ') : ''}`);
    check(await site.evaluate(() => document.querySelectorAll('.flip').length) > 0, 'на сайте есть карточки «Знаешь ли ты?»');
    check(await site.getAttribute('a.download', 'href') === 'progulka/', 'кнопка «Начать прогулку» ведёт на прогулку');
    const routeInfo = await site.evaluate(async () => {
      const r = await (await fetch('data/route.json')).json();
      return { want: r.default_order.length, got: document.querySelectorAll('.route .stop[data-k]').length, lead: document.getElementById('route-lead').textContent };
    });
    check(routeInfo.got === routeInfo.want && routeInfo.lead.startsWith(String(routeInfo.want)),
      `точки маршрута на сайте взяты из данных (${routeInfo.got} из ${routeInfo.want})`);
    check(await site.isVisible('#reviews h2'), 'на сайте есть раздел «Отзывы»');
    check(siteErrors.length === 0, `сайт без ошибок${siteErrors.length ? ': ' + siteErrors.join('; ') : ''}`);

    // Главный экран прогулки помещается на телефон без прокрутки — и в «чистом» виде, и с подсказкой про значок «Домой»
    // (iPhone, со 2-го открытия), найденными вещами и прогулкой на паузе.
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const states = {
      'чистый': null,
      'с найденными вещами': { plan: [], position: 0, found: [0, 1, 2], walkFound: [], badge: false },
      'прогулка на паузе': { plan: [0, 1, 2, 3], position: 2, found: [0, 1], walkFound: [0, 1], badge: false },
    };
    for (const [w, h] of [[390, 664], [375, 667], [360, 640], [412, 780], [320, 568]]) {
      for (const [label, journey] of Object.entries(states)) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, userAgent: IPHONE, hasTouch: true });
        const pg = await ctx.newPage();
        await pg.addInitScript(j => { localStorage.setItem('karavan.opens', '5'); if (j) localStorage.setItem('karavan.journey2', JSON.stringify({ route: 'trosha-lost', ...j })); }, journey);
        await pg.goto(WALK); await pg.waitForSelector('.home-page'); await pg.waitForTimeout(500);
        const over = await pg.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        check(over <= 1, `главный экран ${w}×${h}, ${label}: без прокрутки${over > 1 ? ` (не хватает ${over} px)` : ''}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.log(`\nНе прошло: ${failures.length}`);
    process.exit(1);
  }
  console.log('\nВсё в порядке.');
})().catch(e => { console.error(e); process.exit(1); });
