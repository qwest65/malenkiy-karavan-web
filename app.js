/*
 * «Маленький караван» — веб-версия для iPhone и любых браузеров.
 * Логика повторяет Android-приложение (KaravanController.kt, Journey.kt, Arrival.kt,
 * WalkPath.kt); тексты, линии, наклейки и озвучка готовит tools/build_web.py.
 */
'use strict';

/** Номер веб-версии: виден внизу главного экрана, чтобы понять, обновилось ли приложение. */
const APP_VERSION = '1.10';
const STORE_KEY = 'karavan.journey2';
const HINT_KEY = 'karavan.installHint';
const OPENS_KEY = 'karavan.opens';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/** Радиус прибытия по умолчанию, м. */
const DEFAULT_RADIUS_M = 20;
/** С какого расстояния Троша говорит «точка уже близко». */
const NEAR_METERS = 70;
/** Ближе этого к пешеходной линии стрелка «притягивается» к ней. */
const ON_PATH_METERS = 25;
const DWELL_MS = 5000;
const WALKING_SPEED = 0.7;
const STILL_SPREAD_M = 10;
const LEAVE_FIXES = 2;
const KID_STEP_M = 0.45;
const KID_WALK_M_PER_MIN = 50;
const MINUTES_PER_STOP = 7;

const $app = document.getElementById('app');
const $overlay = document.getElementById('overlay');
const $mapScreen = document.getElementById('map-screen');

/** Сохранение в телефон для работы без интернета: что прислал service worker. */
const OFFLINE = { done: 0, total: 0, update: false, hideAt: 0 };

let route = null;
let legs = new Map();

const S = {
  screen: 'home',
  journey: null,
  opened: 0,
  quizChoice: null,
  optionOrder: [],
  revealed: false,
  heard: false,
  parentOpen: false,
  result: null,
  fix: null,
  shown: null,
  distance: null,
  panelOpen: true,
  editing: null,
  celebrated: new Set(),
};

/* ================= Слова и числа ================= */

function plural(n, one, few, many) {
  const m100 = n % 100, m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}
const pointsWord = n => plural(n, 'точка', 'точки', 'точек');
const stepsWord = n => plural(n, 'шаг', 'шага', 'шагов');
const placesWord = n => plural(n, 'место', 'места', 'мест');

function kidSteps(meters) {
  const steps = meters / KID_STEP_M;
  if (steps < 20) return Math.round(steps);
  if (steps < 200) return Math.round(steps / 10) * 10;
  return Math.round(steps / 50) * 50;
}

function formatDistance(m) {
  if (m < 10) return `${Math.round(m)} м`;
  if (m < 995) return `${Math.round(m / 10) * 10} м`;
  if (m < 10000) return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
  return `${Math.round(m / 1000)} км`;
}

function formatEstimate(min) {
  if (min < 55) return `около ${Math.max(5, Math.floor((min + 4) / 5) * 5)} мин`;
  if (min < 75) return 'около часа';
  if (min < 105) return 'около 1,5 часа';
  if (min < 135) return 'около 2 часов';
  return `около ${String(Math.floor((min + 15) / 30) / 2).replace('.', ',')} часа`;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ================= Геометрия ================= */

const R = 6371000;
const rad = d => d * Math.PI / 180;

function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Пешеходная линия между точками маршрута; точки — [lat, lon]. */
class WalkPath {
  constructor(points) {
    this.points = points;
    this.seg = [];
    for (let i = 0; i < points.length - 1; i++) {
      this.seg.push(distanceMeters(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]));
    }
    this.length = this.seg.reduce((a, b) => a + b, 0);
  }

  reversed() { return new WalkPath(this.points.slice().reverse()); }

  pointAt(along) {
    let left = Math.min(Math.max(along, 0), this.length);
    for (let i = 0; i < this.seg.length; i++) {
      const s = this.seg[i];
      if (left <= s || i === this.seg.length - 1) {
        const t = s === 0 ? 0 : Math.min(Math.max(left / s, 0), 1);
        const a = this.points[i], b = this.points[i + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      left -= s;
    }
    return this.points[this.points.length - 1];
  }

  remainingFrom(along) {
    const out = [this.pointAt(along)];
    let passed = 0;
    for (let i = 0; i < this.seg.length; i++) {
      passed += this.seg[i];
      if (passed > along) out.push(this.points[i + 1]);
    }
    if (out.length < 2) out.push(this.points[this.points.length - 1]);
    return out;
  }

  progress(lat, lon) {
    let bestOff = Infinity, bestRemaining = this.length, after = this.length;
    for (let i = 0; i < this.seg.length; i++) {
      after -= this.seg[i];
      const a = this.points[i], b = this.points[i + 1];
      const kx = 111320 * Math.cos(rad(a[0]));
      const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * 111320;
      const px = (lon - a[1]) * kx, py = (lat - a[0]) * 111320;
      const len2 = bx * bx + by * by;
      const t = len2 === 0 ? 0 : Math.min(Math.max((px * bx + py * by) / len2, 0), 1);
      const off = Math.hypot(px - t * bx, py - t * by);
      if (off < bestOff) {
        bestOff = off;
        bestRemaining = (1 - t) * this.seg[i] + after;
      }
    }
    return { off: bestOff, remaining: bestRemaining, along: this.length - bestRemaining };
  }
}

/* ---------- Повороты, как Navigation.kt ---------- */

const MIN_TURN_DEG = 30, SHARP_DEG = 60, U_TURN_DEG = 160;
/** Направление до и после излома — по отрезку такой длины, чтобы мелкие зигзаги не мешали. */
const WINDOW_M = 12;
const MERGE_M = 15;
const SKIP_START_M = 10;
const PASSED_M = 5;
/** За сколько метров до поворота Троша о нём говорит. */
const TURN_ANNOUNCE_METERS = 20;
/** Ближе этого к повороту пишем «сейчас». */
const NOW_METERS = 8;

function bearingDegrees(a, b) {
  const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Разница направлений −180..180; плюс — вправо. */
function angleDelta(from, to) {
  const d = (((to - from) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

function findManeuvers(path) {
  const pts = path.points;
  if (pts.length < 3) return [];
  const at = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + path.seg[i - 1]);
  const length = path.length;
  const d2 = (a, b) => distanceMeters(a[0], a[1], b[0], b[1]);
  const bends = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = at[i];
    if (d < SKIP_START_M || length - d < PASSED_M) continue;
    const before = path.pointAt(d - WINDOW_M), after = path.pointAt(d + WINDOW_M);
    if (d2(before, pts[i]) < 1 || d2(pts[i], after) < 1) continue;
    const delta = angleDelta(bearingDegrees(before, pts[i]), bearingDegrees(pts[i], after));
    if (Math.abs(delta) >= MIN_TURN_DEG) bends.push({ at: d, delta });
  }
  const merged = [];
  for (const b of bends) {
    const last = merged[merged.length - 1];
    if (last && b.at - last.at < MERGE_M) {
      if (Math.abs(b.delta) > Math.abs(last.delta)) merged[merged.length - 1] = b;
    } else merged.push(b);
  }
  return merged.map(b => ({ at: b.at, turn: turnOf(b.delta) }));
}

function turnOf(delta) {
  if (Math.abs(delta) >= U_TURN_DEG) return 'u_turn';
  if (delta <= -SHARP_DEG) return 'left';
  if (delta < 0) return 'slight_left';
  if (delta >= SHARP_DEG) return 'right';
  return 'slight_right';
}

/** Ближайший поворот через inMeters или, если поворотов больше нет, сколько идти прямо. */
function nextInstruction(path, along) {
  if (!path.maneuvers) path.maneuvers = findManeuvers(path);
  const next = path.maneuvers.find(m => m.at > along - PASSED_M);
  if (!next) return { turn: null, inMeters: Math.max(path.length - along, 0), at: null };
  return { turn: next.turn, inMeters: Math.max(next.at - along, 0), at: next.at };
}

const TURN_CLIP = { left: 'phrase_turn_left', right: 'phrase_turn_right', slight_left: 'phrase_slight_left', slight_right: 'phrase_slight_right', u_turn: 'phrase_u_turn' };
const TURN_WORD = { left: 'налево', right: 'направо', slight_left: 'чуть левее', slight_right: 'чуть правее', u_turn: 'разворот' };
const TURN_ROTATE = { left: -90, slight_left: -45, right: 90, slight_right: 45, u_turn: 0 };

/* ---------- Куда смотрит телефон, как HeadingFusion ---------- */

/** Магнитное склонение в Троицке, градусы к востоку: компас показывает на магнитный север. */
const DECLINATION = 13;
const H = { heading: null, gps: null, gpsAt: -Infinity, compass: null, listening: false, course: null, courseAt: -Infinity, coursePos: null };

function onGpsHeading(c) {
  if (Number.isFinite(c.heading) && Number.isFinite(c.speed) && c.speed >= 1) {
    H.gps = c.heading;
    H.gpsAt = Date.now();
    H.heading = c.heading;
    headingChanged();
  }
}

function onCompass(deg) {
  const d = ((deg + DECLINATION) % 360 + 360) % 360;
  H.compass = H.compass == null ? d : (H.compass + angleDelta(H.compass, d) * 0.2 + 360) % 360;
  if (Date.now() - H.gpsAt > 4000) H.heading = H.compass;
  headingChanged();
}

/** Направление, которому можно верить сейчас: компас или свежий курс GPS, пока идём. */
function freshHeading() {
  if (H.listening && H.compass != null) return H.heading;
  if (Date.now() - H.gpsAt < 5000) return H.gps;
  return Date.now() - H.courseAt < 15000 ? H.course : null;
}

/**
 * Куда повернуть карту. На маршруте — по направлению пути впереди, как в навигаторе:
 * путь всегда смотрит вверх, даже если идём медленно. Вне пути — компас или куда мы
 * сместились за последние метры. Не знаем — оставляем как есть.
 */
function mapBearing() {
  if (G.routeBearing != null) return G.routeBearing;
  return freshHeading();
}

/** Направление движения по самим координатам: GPS iPhone даёт курс только быстрее 1 м/с. */
const COURSE_STEP_M = 8;
function trackCourse(fix) {
  const last = H.coursePos;
  if (!last) { H.coursePos = [fix.lat, fix.lon]; return; }
  const moved = distanceMeters(last[0], last[1], fix.lat, fix.lon);
  if (moved >= COURSE_STEP_M) {
    H.course = bearingDegrees(last, [fix.lat, fix.lon]);
    H.courseAt = Date.now();
    H.coursePos = [fix.lat, fix.lon];
  }
}

let headingFrame = 0;
function headingChanged() {
  if (headingFrame) return;
  headingFrame = requestAnimationFrame(() => {
    headingFrame = 0;
    if (S.screen === 'walk') { updateBanner(); drawMe(); followCamera(false); }
  });
}

/**
 * Компас. Где он доступен без вопросов (Android), включается сам. На iPhone для него нужно
 * отдельное разрешение — его не спрашиваем: родителю с ребёнком не до лишних окон. Там
 * карта поворачивается по направлению движения из GPS.
 */
const compassNeedsTap = !!(window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function');

function enableCompass() {
  if (H.listening) return;
  const listen = () => {
    H.listening = true;
    window.addEventListener('deviceorientation', e => {
      if (Number.isFinite(e.webkitCompassHeading)) onCompass(e.webkitCompassHeading);
    });
    window.addEventListener('deviceorientationabsolute', e => {
      if (Number.isFinite(e.alpha)) onCompass(360 - e.alpha);
    });
  };
  const D = window.DeviceOrientationEvent;
  if (D && !compassNeedsTap) listen();
}

const between = (a, b) => legs.get(`${a}-${b}`) || null;

/**
 * Улицы и тротуары центра Троицка без дворов (как StreetGraph.kt): по ним прямо в телефоне,
 * без интернета, строится путь «от меня до точки».
 */
class StreetGraph {
  constructor(nodes, edges) {
    const n = nodes.length / 2, m = edges.length / 3;
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.lat[i] = nodes[2 * i]; this.lon[i] = nodes[2 * i + 1]; }
    this.a = new Int32Array(m);
    this.b = new Int32Array(m);
    this.cost = new Float64Array(m);
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      const a = edges[3 * e], b = edges[3 * e + 1];
      this.a[e] = a; this.b[e] = b;
      this.cost[e] = distanceMeters(this.lat[a], this.lon[a], this.lat[b], this.lon[b]) * edges[3 * e + 2] / 100;
      deg[a + 1]++; deg[b + 1]++;
    }
    for (let i = 1; i <= n; i++) deg[i] += deg[i - 1];
    this.start = deg;
    this.adj = new Int32Array(m * 2);
    const fill = deg.slice();
    for (let e = 0; e < m; e++) { this.adj[fill[this.a[e]]++] = e; this.adj[fill[this.b[e]]++] = e; }
  }

  snap(lat, lon) {
    let best = null;
    const kx = 111320 * Math.cos(rad(lat));
    for (let e = 0; e < this.a.length; e++) {
      const a = this.a[e], b = this.b[e];
      const bx = (this.lon[b] - this.lon[a]) * kx, by = (this.lat[b] - this.lat[a]) * 111320;
      const px = (lon - this.lon[a]) * kx, py = (lat - this.lat[a]) * 111320;
      const len2 = bx * bx + by * by;
      const t = len2 === 0 ? 0 : Math.min(Math.max((px * bx + py * by) / len2, 0), 1);
      const d = Math.hypot(px - t * bx, py - t * by);
      if (!best || d < best.d) {
        best = { e, t, d, p: [this.lat[a] + (this.lat[b] - this.lat[a]) * t, this.lon[a] + (this.lon[b] - this.lon[a]) * t] };
      }
    }
    return best;
  }

  /** Путь по улицам от from до to ([lat, lon]); null — одна из точек дальше 150 м от улиц центра. */
  route(from, to, maxSnap = 150) {
    const s = this.snap(from[0], from[1]);
    const g = this.snap(to[0], to[1]);
    if (!s || !g || s.d > maxSnap || g.d > maxSnap) return null;
    const middle = s.e === g.e ? [s.p, g.p] : [s.p, ...this.shortest(s, g), g.p];
    const out = [from];
    for (const p of [...middle, to]) {
      const last = out[out.length - 1];
      if (distanceMeters(last[0], last[1], p[0], p[1]) > 0.5) out.push(p);
    }
    if (out.length < 2) out.push(to);
    return out;
  }

  /** Дейкстра между точками на разных отрезках. */
  shortest(s, g) {
    const n = this.lat.length;
    const best = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = [];
    const push = (node, cost, from) => {
      if (cost >= best[node]) return;
      best[node] = cost; prev[node] = from;
      heap.push([cost, node]);
      let i = heap.length - 1;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (heap[up][0] <= heap[i][0]) break;
        [heap[up], heap[i]] = [heap[i], heap[up]]; i = up;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    push(this.a[s.e], s.t * this.cost[s.e], -1);
    push(this.b[s.e], (1 - s.t) * this.cost[s.e], -1);
    const gA = this.a[g.e], gB = this.b[g.e];
    const tailA = g.t * this.cost[g.e], tailB = (1 - g.t) * this.cost[g.e];
    let done = 0;
    while (heap.length) {
      const [cost, u] = pop();
      if (cost > best[u]) continue;
      if (u === gA || u === gB) done++;
      if (done === 2 || (best[gA] + tailA <= cost && best[gB] + tailB <= cost)) break;
      for (let i = this.start[u]; i < this.start[u + 1]; i++) {
        const e = this.adj[i];
        push(this.a[e] === u ? this.b[e] : this.a[e], cost + this.cost[e], u);
      }
    }
    const end = best[gA] + tailA <= best[gB] + tailB ? gA : gB;
    if (best[end] === Infinity) return [];
    const chain = [];
    for (let k = end; k !== -1; k = prev[k]) chain.push([this.lat[k], this.lon[k]]);
    return chain.reverse();
  }
}
let streets = null;

/** Ломаная Valhalla (polyline с точностью 6 знаков) → [[lat, lon], …]. */
function decodePolyline6(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}

/** Запасной пешеходный маршрутизатор — Valhalla сервиса FOSSGIS (им пользуется сайт OpenStreetMap). */
async function valhallaRoute(from, to) {
  const q = { locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }], costing: 'pedestrian' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(q))}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const pts = decodePolyline6(json.trip.legs[0].shape);
    return pts.length >= 2 ? [from, ...pts, to] : null;
  } catch (_) {
    return null;
  }
}

/** Пешеходный путь через интернет: сначала OSRM, если он не ответил — Valhalla. */
async function onlineRoute(from, to) {
  const osrm = await osrmRoute(from, to);
  if (osrm) return { line: osrm, source: 'osrm' };
  const valhalla = await valhallaRoute(from, to);
  if (valhalla) return { line: valhalla, source: 'valhalla' };
  return null;
}

/** Пешеходный путь у OSRM (профиль foot), если мы далеко от улиц центра. Без интернета — null. */
async function osrmRoute(from, to) {
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/` +
    `${from[1].toFixed(6)},${from[0].toFixed(6)};${to[1].toFixed(6)},${to[0].toFixed(6)}?overview=full&geometries=geojson`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 'Ok') return null;
    const pts = json.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    return pts.length >= 2 ? [from, ...pts, to] : null;
  } catch (_) {
    return null;
  }
}

function planMeters(plan) {
  let sum = 0;
  for (let i = 0; i < plan.length - 1; i++) {
    const p = between(plan[i], plan[i + 1]);
    if (!p) return null;
    sum += p.length;
  }
  return sum;
}

function planSummary(plan) {
  const meters = plan.length > 1 ? planMeters(plan) : null;
  const parts = [`${plan.length} ${pointsWord(plan.length)}`];
  if (meters != null) parts.push(`${formatDistance(meters)} пешком`);
  parts.push(formatEstimate(Math.round((meters || 0) / KID_WALK_M_PER_MIN) + plan.length * MINUTES_PER_STOP));
  return parts.join(' · ');
}

/* ================= Прогулка и альбом ================= */

function newJourney() {
  return { plan: [], position: 0, found: [], walkFound: [], badge: false };
}

function loadJourney() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (j && j.route === route.id) {
      const n = route.stops.length;
      const ok = a => (Array.isArray(a) ? a : []).filter(i => Number.isInteger(i) && i >= 0 && i < n);
      const plan = [...new Set(ok(j.plan))];
      return {
        plan,
        position: Math.min(Math.max(j.position | 0, 0), plan.length),
        found: [...new Set(ok(j.found))],
        walkFound: [...new Set(ok(j.walkFound))],
        badge: !!j.badge,
      };
    }
  } catch (_) { /* хранилище недоступно — начинаем с чистого альбома */ }
  return newJourney();
}

function saveJourney() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ route: route.id, ...S.journey }));
  } catch (_) { /* приватный режим: прогресс живёт до закрытия вкладки */ }
}

const J = {
  get inProgress() { return S.journey.plan.length > 0; },
  get complete() { return this.inProgress && S.journey.position === S.journey.plan.length; },
  get active() { const j = S.journey; return j.position < j.plan.length ? j.plan[j.position] : null; },
  get previous() { const j = S.journey; return j.position > 0 ? j.plan[j.position - 1] : null; },
  isFound: i => S.journey.found.includes(i),
};

function setJourney(j) {
  S.journey = j;
  saveJourney();
}

/* ================= Озвучка ================= */

const player = {
  el: new Audio(),
  queue: [],
  current: null,
  play(...clips) { this.queue = clips.slice(); this.next(); },
  enqueue(clip) { if (this.current) this.queue.push(clip); else this.play(clip); },
  stop() { this.queue = []; this.current = null; this.el.pause(); onAudio(); },
  next() {
    this.current = this.queue.shift() || null;
    onAudio();
    if (!this.current) { this.el.pause(); return; }
    this.el.src = `audio/${this.current}.mp3`;
    const p = this.el.play();
    if (p) p.catch(() => { this.queue = []; this.current = null; onAudio(); });
  },
};
player.el.preload = 'auto';
player.el.addEventListener('ended', () => player.next());
player.el.addEventListener('error', () => player.next());

const Clips = {
  narrator: i => `stop${i + 1}_narrator`,
  trosha: i => `stop${i + 1}_trosha`,
  task: i => `stop${i + 1}_task`,
  parent: i => `stop${i + 1}_parent`,
  arrival: i => ['bell', 'phrase_arrived', `stop${i + 1}_narrator`, `stop${i + 1}_trosha`, `stop${i + 1}_task`],
};

function onAudio() {
  if (S.screen === 'stop') {
    const i = S.opened, c = player.current;
    if (c) S.heard = true;
    if (!S.revealed && (c === Clips.trosha(i) || c === Clips.task(i) || (!c && S.heard))) reveal();
  }
  document.querySelectorAll('[data-speaker]').forEach(b => {
    const parent = b.dataset.speaker === 'parent';
    b.textContent = parent
      ? (player.current === Clips.parent(S.opened) ? 'Остановить' : 'Подробная история голосом')
      : (player.current ? '⏹' : '🔊');
  });
}

/* ================= Не гасить экран ================= */

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) { /* не поддерживается — экран может погаснуть */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.screen === 'walk') keepAwake(true);
});

/* ================= Геолокация и прибытие ================= */

class ArrivalDetector {
  constructor(radius) { this.radius = radius; this.reset(); }
  reset() { this.stillSince = null; this.anchor = null; this.outside = 0; }
  onFix(lat, lon, dist, speed, now) {
    if (dist > this.radius) {
      if (++this.outside >= LEAVE_FIXES) this.reset();
      return this.check(now);
    }
    this.outside = 0;
    if (speed != null && speed >= WALKING_SPEED) {
      this.stillSince = null;
      this.anchor = [lat, lon];
    } else if (this.anchor && distanceMeters(this.anchor[0], this.anchor[1], lat, lon) > STILL_SPREAD_M) {
      this.stillSince = now;
      this.anchor = [lat, lon];
    } else if (this.stillSince == null) {
      this.stillSince = now;
      this.anchor = this.anchor || [lat, lon];
    }
    return this.check(now);
  }
  check(now) { return this.stillSince != null && now - this.stillSince >= DWELL_MS; }
}

const G = {
  watch: null, arrival: null, target: null, near: false, ahead: null, speed: null, denied: false,
  // Путь «от меня до точки» по улицам: к первой точке прогулки или построенный заново, если свернули.
  approach: null, approachTarget: null, offFixes: 0, wasOnPath: false,
  // Откуда путь к точке — для подписи на карте во время проверки веб-версии.
  source: null,
  lastReroute: -Infinity, lastOnline: -Infinity, inFlight: false,
};
/** Как Reroute в WalkPath.kt: по встроенным улицам — раз в 3 с, через интернет — раз в 20 с. */
const REROUTE_CONFIRM_FIXES = 2;
const OFFLINE_INTERVAL_MS = 3000;
const ONLINE_INTERVAL_MS = 20000;

/*
 * Геопозиция. У приложения с экрана «Домой» iPhone постоянное слежение (watchPosition)
 * иногда молча не запускается — ни окна разрешения, ни ошибки. Поэтому по нажатию сначала
 * разовый запрос (он показывает окно «Разрешить?»), потом слежение, а если оно молчит
 * дольше 10 секунд — разовые запросы каждые 3 секунды.
 */
const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 };
const GEO = { status: 'idle', since: 0, lastFixAt: 0, asking: false, askedAt: 0, watchAt: 0, poll: null };

function startTracking() {
  if (!compassNeedsTap) enableCompass();
  if (!('geolocation' in navigator)) { GEO.status = 'unsupported'; return; }
  if (GEO.status !== 'ok') { GEO.status = 'wait'; GEO.since = Date.now(); }
  askOnce();
  startWatch();
  if (GEO.poll == null) {
    GEO.poll = setInterval(() => {
      if (S.screen === 'walk') { updateBanner(); drawMe(); }
      const now = Date.now();
      if (now - GEO.lastFixAt > 10000) {
        // Запрос, на который телефон так и не ответил, не должен навсегда блокировать новые.
        if (GEO.asking && now - GEO.askedAt > 25000) GEO.asking = false;
        askOnce();
        // Молчащее слежение перезапускаем раз в 30 секунд.
        if (now - GEO.watchAt > 30000) startWatch(true);
      }
      if (S.screen === 'walk') updateWalkView();
    }, 3000);
  }
}

function startWatch(restart) {
  if (restart && G.watch != null) { navigator.geolocation.clearWatch(G.watch); G.watch = null; }
  if (G.watch != null) return;
  GEO.watchAt = Date.now();
  G.watch = navigator.geolocation.watchPosition(onFix, onGeoError, GEO_OPTIONS);
}

function askOnce() {
  if (GEO.asking) return;
  GEO.asking = true;
  GEO.askedAt = Date.now();
  navigator.geolocation.getCurrentPosition(
    pos => { GEO.asking = false; onFix(pos); },
    err => { GEO.asking = false; onGeoError(err); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

function stopTracking() {
  if (G.watch != null) navigator.geolocation.clearWatch(G.watch);
  G.watch = null;
  clearInterval(GEO.poll);
  GEO.poll = null;
  if (GEO.status === 'ok') GEO.status = 'idle';
}

/** Для диагностики на iPhone: что ответил телефон в последний раз. */
const GEO_DIAG = { perm: null, error: null };
function readGeoPermission() {
  if (!navigator.permissions || !navigator.permissions.query) { GEO_DIAG.perm = 'нет данных'; return; }
  navigator.permissions.query({ name: 'geolocation' }).then(st => {
    const word = { granted: 'разрешена', denied: 'запрещена', prompt: 'спросит' };
    GEO_DIAG.perm = word[st.state] || st.state;
    st.onchange = () => { GEO_DIAG.perm = word[st.state] || st.state; if (S.screen === 'home') render(); };
    if (S.screen === 'home') render();
  }).catch(() => { GEO_DIAG.perm = 'нет данных'; });
}

function onGeoError(err) {
  GEO_DIAG.error = `код ${err.code}${err.message ? `: ${err.message}` : ''}`;
  if (err.code === err.PERMISSION_DENIED) {
    GEO.status = 'denied';
    G.denied = true;
    stopTracking();
  } else if (GEO.status !== 'ok') {
    GEO.status = err.code === err.POSITION_UNAVAILABLE ? 'nosignal' : 'wait';
  }
  if (S.screen === 'walk') updateWalkView();
}

function onFix(pos) {
  const c = pos.coords;
  GEO.status = 'ok';
  GEO.lastFixAt = Date.now();
  G.denied = false;
  S.fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy };
  G.speed = Number.isFinite(c.speed) ? c.speed : null;
  onGpsHeading(c);
  trackCourse(S.fix);
  updateGuidance();
}

/** Что писать вместо шагов, пока координат нет: коротко и без инструкций по настройкам. */
function geoMessage() {
  if (GEO.status === 'denied' || GEO.status === 'unsupported' || Date.now() - GEO.since > 20000) {
    return 'Без геопозиции — нажмите «Мы на месте!», когда подойдёте к точке.';
  }
  if (GEO.status === 'nosignal') return 'Ловим GPS… Выйдите на открытое место.';
  return 'Ищем, где мы… Если телефон спросит про геопозицию — нажмите «Разрешить».';
}

function updateGuidance() {
  const fix = S.fix;
  const target = J.active;
  if (!fix || target == null) {
    S.distance = null;
    S.shown = fix;
    return;
  }
  const stop = route.stops[target];
  const radius = stop.radius || DEFAULT_RADIUS_M;
  if (G.target !== target) {
    G.target = target;
    G.near = false;
    G.turnAt = null;
    G.wasOnPath = false;
    G.offFixes = 0;
    G.arrival = new ArrivalDetector(radius);
  }
  const straight = distanceMeters(fix.lat, fix.lon, stop.lat, stop.lon);
  const prev = J.previous;
  const leg = prev != null ? between(prev, target) : null;
  // Путь к точке: построенный заново «от меня», а если его нет — линия маршрута от прошлой точки.
  const approach = G.approachTarget === target ? G.approach : null;
  const path = approach || leg;
  const pr = path ? path.progress(fix.lat, fix.lon) : null;
  if (pr && pr.off <= ON_PATH_METERS) {
    G.offFixes = 0;
    G.wasOnPath = true;
    if (!approach) G.source = 'leg';
    G.straight = false;
    const p = path.pointAt(pr.along);
    S.shown = { lat: p[0], lon: p[1] };
    S.distance = pr.remaining;
    G.ahead = path.remainingFrom(pr.along);
    guide(path, pr.along);
    // Направление пути на 20 м вперёд — по нему поворачиваем карту.
    const ahead = path.pointAt(pr.along + 20);
    G.routeBearing = distanceMeters(p[0], p[1], ahead[0], ahead[1]) > 3 ? bearingDegrees(p, ahead) : G.routeBearing;
  } else {
    G.offFixes++;
    S.shown = fix;
    S.distance = straight;
    S.instruction = null;
    G.routeBearing = null;
    // Пока путь по улицам строится (или его нет совсем) — тянем к точке пунктир по прямой.
    G.ahead = [[fix.lat, fix.lon], [stop.lat, stop.lon]];
    G.straight = true;
    if (S.screen === 'walk') reroute(fix, target, path != null);
  }
  if (!G.near && S.distance <= NEAR_METERS && S.distance > radius) {
    G.near = true;
    if (S.screen === 'walk') player.enqueue('phrase_near');
  }
  const arrived = G.arrival.onFix(fix.lat, fix.lon, straight, G.speed, Date.now());
  if (S.screen === 'walk') {
    if (arrived) { arrive(); return; }
    updateWalkView();
  }
}

/** Свернули или пути ещё нет — строим от того места, где стоим: по улицам центра, а если далеко — у OSRM. */
function reroute(fix, target, hasPath) {
  const now = Date.now();
  if (now - G.lastReroute < OFFLINE_INTERVAL_MS) return;
  if (hasPath && G.offFixes < REROUTE_CONFIRM_FIXES) return;
  G.lastReroute = now;
  if (hasPath && G.wasOnPath) {
    G.wasOnPath = false;
    player.enqueue('phrase_off_route');
  }
  const from = [fix.lat, fix.lon];
  const to = [route.stops[target].lat, route.stops[target].lon];
  const line = streets ? streets.route(from, to) : null;
  if (line) {
    G.source = 'streets';
    setApproach(line, target);
    updateGuidance();
    return;
  }
  if (G.inFlight || now - G.lastOnline < ONLINE_INTERVAL_MS) return;
  G.inFlight = true;
  G.lastOnline = now;
  G.source = G.source === 'osrm' || G.source === 'valhalla' ? G.source : 'pending';
  onlineRoute(from, to).then(online => {
    G.inFlight = false;
    if (online && J.active === target) {
      G.source = online.source;
      setApproach(online.line, target);
      updateGuidance();
    } else if (!online) {
      G.source = navigator.onLine === false ? 'offline' : 'failed';
      updateWalkView();
    }
  });
}

/** Подсказка о ближайшем повороте; за 20 м до него Троша говорит, куда повернуть. */
function guide(path, along) {
  const next = nextInstruction(path, along);
  S.instruction = next;
  if (!next.turn || next.at == null) return;
  if (next.inMeters <= TURN_ANNOUNCE_METERS && (G.turnAt == null || Math.abs(G.turnAt - next.at) > 1 || G.turnPath !== path)) {
    G.turnAt = next.at;
    G.turnPath = path;
    if (S.screen === 'walk') player.enqueue(TURN_CLIP[next.turn]);
  }
}

function setApproach(line, target) {
  G.turnAt = null;
  G.approach = new WalkPath(line);
  G.approachTarget = target;
  G.offFixes = 0;
}

setInterval(() => {
  if (S.screen === 'walk' && G.arrival && G.arrival.check(Date.now())) arrive();
}, 1000);

/* ================= Карта ================= */

/**
 * Как в навигаторе (KaravanMap.kt): карта следует за нами, повёрнута туда, куда идём, и чуть
 * наклонена. Сдвинули или повернули карту пальцами — слежение выключается и само возвращается
 * через 8 секунд. Наклон пальцами выключен: детям он только мешает.
 */
const FOLLOW_ZOOM = 17.5;
const FOLLOW_PITCH = 40;
const RESUME_FOLLOW_MS = 8000;
const M = { map: null, ready: false, markers: [], me: null, following: true, fitted: false, resume: null, lastCam: 0 };

const BLANK_STYLE = {
  version: 8, sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#efe6d2' } }],
};

function ensureMap() {
  if (M.map || !window.maplibregl) return;
  const first = route.stops[route.default_order[0]];
  M.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [first.lon, first.lat],
    zoom: 15,
    attributionControl: { compact: true },
    pitchWithRotate: false,
  });
  M.map.touchPitch.disable();
  let fellBack = false;
  M.map.on('error', e => {
    // Нет интернета и тайлов в кэше — показываем линии и точки на простом фоне.
    if (!fellBack && !M.ready && e && e.error && /style|Failed to fetch|NetworkError|Load failed/i.test(String(e.error.message || e.error))) {
      fellBack = true;
      M.map.setStyle(BLANK_STYLE);
    }
  });
  M.map.on('style.load', () => {
    M.ready = true;
    addLayers();
    drawMap();
  });
  const userMoves = () => {
    M.following = false;
    clearTimeout(M.resume);
    updateWalkView();
  };
  M.map.on('dragstart', userMoves);
  M.map.on('rotatestart', e => { if (e.originalEvent) userMoves(); });
  M.map.on('rotate', updateNorth);
  M.map.on('moveend', e => {
    // Карту отпустили — через несколько секунд она сама вернётся к нам.
    if (!M.following && (e.originalEvent || e.fit)) {
      clearTimeout(M.resume);
      M.resume = setTimeout(follow, RESUME_FOLLOW_MS);
    }
  });
}

function addLayers() {
  const m = M.map;
  const empty = { type: 'FeatureCollection', features: [] };
  if (!m.getSource('plan')) m.addSource('plan', { type: 'geojson', data: empty });
  if (!m.getSource('ahead')) m.addSource('ahead', { type: 'geojson', data: empty });
  if (!m.getLayer('plan')) {
    m.addLayer({ id: 'plan', type: 'line', source: 'plan', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#d2463c', 'line-opacity': 0.35, 'line-width': 5, 'line-dasharray': [1, 1.6] } });
  }
  if (!m.getLayer('ahead')) {
    m.addLayer({ id: 'ahead', type: 'line', source: 'ahead', filter: ['!=', ['get', 'straight'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3e9c6a', 'line-width': 8 } });
  }
  if (!m.getLayer('ahead-straight')) {
    m.addLayer({ id: 'ahead-straight', type: 'line', source: 'ahead', filter: ['==', ['get', 'straight'], true],
      layout: { 'line-cap': 'round' }, paint: { 'line-color': '#3e9c6a', 'line-width': 6, 'line-dasharray': [0.5, 2] } });
  }
}

const lineFeature = pts => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(p => [p[1], p[0]]) } });

function drawMap() {
  if (!M.map) return;
  const j = S.journey;
  const target = J.active;

  M.markers.forEach(mk => mk.remove());
  M.markers = j.plan.map((i, pos) => {
    const stop = route.stops[i];
    const el = document.createElement('div');
    if (J.isFound(i) && pos < j.position) {
      el.className = 'stop-pin done';
      el.innerHTML = `<img src="stickers/${stop.sticker}.webp" alt="">`;
    } else {
      el.className = 'stop-pin' + (i === target ? ' target' : pos < j.position ? ' dim' : '');
      el.textContent = String(pos + 1);
    }
    el.title = stop.title;
    return new maplibregl.Marker({ element: el }).setLngLat([stop.lon, stop.lat]).addTo(M.map);
  });

  if (M.ready) {
    const plan = [];
    for (let k = 0; k < j.plan.length - 1; k++) {
      const p = between(j.plan[k], j.plan[k + 1]);
      plan.push(lineFeature(p ? p.points : [[route.stops[j.plan[k]].lat, route.stops[j.plan[k]].lon], [route.stops[j.plan[k + 1]].lat, route.stops[j.plan[k + 1]].lon]]));
    }
    M.map.getSource('plan').setData({ type: 'FeatureCollection', features: plan });
  }
  drawLive();
  if (!M.fitted) {
    M.fitted = true;
    // Пока координат нет — показываем весь маршрут; первый замер GPS переведёт карту в навигатор.
    if (S.shown) followCamera(true); else { fitAll(); M.following = true; clearTimeout(M.resume); }
  }
}

/** То, что меняется с каждым замером GPS: стрелка «я» и путь впереди. */
function drawLive() {
  if (!M.map) return;
  const shown = S.shown;
  if (shown) {
    if (!M.me) {
      const el = document.createElement('div');
      el.className = 'me';
      el.innerHTML = '<div class="me-arrow"></div><div class="me-dot"></div>';
      M.me = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([shown.lon, shown.lat]).addTo(M.map);
    } else {
      M.me.setLngLat([shown.lon, shown.lat]);
    }
    drawMe();
    followCamera(true);
  }
  if (M.ready) {
    const ahead = G.ahead && J.active != null ? [{ ...lineFeature(G.ahead), properties: { straight: !!G.straight } }] : [];
    M.map.getSource('ahead').setData({ type: 'FeatureCollection', features: ahead });
  }
}

/** Стрелка «я»: направлена туда, куда смотрит телефон. */
function drawMe() {
  if (!M.me) return;
  const el = M.me.getElement();
  const h = H.listening && H.compass != null ? H.heading : mapBearing();
  el.classList.toggle('has-heading', h != null);
  if (h != null) M.me.setRotation(h);
}

/** Камера навигатора: мы в центре, карта повёрнута по направлению движения. */
function followCamera(force) {
  if (!M.map || !M.following || !S.shown) return;
  const now = Date.now();
  if (!force && now - M.lastCam < 300) return;
  M.lastCam = now;
  M.map.easeTo({
    center: [S.shown.lon, S.shown.lat],
    zoom: FOLLOW_ZOOM,
    bearing: mapBearing() ?? M.map.getBearing(),
    pitch: FOLLOW_PITCH,
    padding: { top: 0, bottom: Math.round(M.map.getContainer().clientHeight * 0.3), left: 0, right: 0 },
    duration: force ? 600 : 300,
  });
}

function fitAll() {
  if (!M.map) return;
  const pts = S.journey.plan.map(i => [route.stops[i].lon, route.stops[i].lat]);
  if (S.shown) pts.push([S.shown.lon, S.shown.lat]);
  if (!pts.length) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  M.following = false;
  clearTimeout(M.resume);
  const h = M.map.getContainer().clientHeight;
  const bottom = Math.min(440, Math.round(h * 0.5));
  M.map.fitBounds(b, { padding: { top: 170, bottom, left: 50, right: 50 }, maxZoom: 17, duration: 500, bearing: 0, pitch: 0 }, { fit: true });
}

/** Кнопка «север»: видна, пока карту повернули вручную; стрелка показывает, где север. */
function updateNorth() {
  const btn = document.getElementById('north-btn');
  if (!btn || !M.map) return;
  const bearing = M.map.getBearing();
  btn.hidden = M.following || Math.abs(bearing) < 1;
  btn.firstElementChild.style.transform = `rotate(${-bearing}deg)`;
}

function north() {
  if (!M.map) return;
  M.following = false;
  clearTimeout(M.resume);
  M.map.easeTo({ bearing: 0, duration: 400 });
  M.resume = setTimeout(follow, RESUME_FOLLOW_MS);
  updateWalkView();
}

function follow() {
  clearTimeout(M.resume);
  M.following = true;
  followCamera(true);
  updateWalkView();
}

/* ================= Действия ================= */

function go(screen) {
  // На прогулку — с развёрнутой панелью: видно, куда идём, а через 5 секунд она свернётся сама.
  if (screen === 'walk' && S.screen !== 'walk') S.panelOpen = true;
  S.screen = screen;
  if (screen !== 'home' && history.state?.inner !== true) history.pushState({ inner: true }, '');
  render();
}

function openChooser() { player.stop(); S.editing = null; go('choose'); }

function startWalk(selection) {
  const chosen = [...new Set(selection)].filter(i => i >= 0 && i < route.stops.length);
  if (!chosen.length) return;
  player.stop();
  setJourney({ ...S.journey, plan: chosen, position: 0, walkFound: [] });
  S.celebrated.clear();
  G.target = null;
  startTracking();
  go('walk');
  player.play('intro_trosha', 'phrase_road');
}

function resumeWalk() {
  if (!J.inProgress) return;
  player.stop();
  G.target = null;
  startTracking();
  go('walk');
  player.play('phrase_go');
}

function pause() { player.stop(); go('home'); }

/**
 * Своё окно «Вы уверены?». Стандартный confirm() приложение с экрана «Домой» iPhone
 * часто не показывает и сразу отвечает «нет».
 */
function ask(title, text, okLabel, cancelLabel) {
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'dialog-wrap';
    box.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-t">${esc(title)}</div><div class="dialog-s">${esc(text)}</div>
      <div class="dialog-b"><button class="link" data-a="no">${esc(cancelLabel)}</button>
      <button class="btn" data-a="yes" style="width:auto;min-height:52px;font-size:18px">${esc(okLabel)}</button></div></div>`;
    box.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (!a && e.target !== box) return;
      box.remove();
      resolve(!!a && a.dataset.a === 'yes');
    });
    document.body.appendChild(box);
  });
}

async function finishWalk() {
  if (!J.inProgress) return;
  const ok = await ask('Завершить прогулку?', 'Найденные вещи останутся в альбоме. Остальные точки можно пройти в другой раз.', 'Завершить', 'Гуляем дальше');
  if (ok && J.inProgress) endWalk(false);
}

function skipStop() {
  player.stop();
  const j = S.journey;
  if (J.active == null) return;
  const next = { ...j, position: j.position + 1 };
  if (next.position === next.plan.length && next.walkFound.length) next.badge = true;
  setJourney(next);
  if (J.complete) {
    endWalk(S.journey.walkFound.length > 0);
  } else {
    go('walk');
    player.play('phrase_go');
  }
}

function arrive() {
  const stop = J.active;
  if (stop == null) return;
  if (G.arrival) G.arrival.reset();
  S.opened = stop;
  S.quizChoice = null;
  S.revealed = false;
  S.heard = false;
  S.parentOpen = false;
  S.optionOrder = route.stops[stop].question.options.map((_, i) => i).sort(() => Math.random() - 0.5);
  go('stop');
  window.scrollTo(0, 0);
  player.play(...Clips.arrival(stop));
}

function reveal() {
  S.revealed = true;
  if (S.screen !== 'stop') return;
  render();
  if (!S.celebrated.has(S.opened)) {
    S.celebrated.add(S.opened);
    const stop = route.stops[S.opened];
    celebrate(stop.sticker, 'Ура! Нашлось!', stop.item, () => {
      const bp = document.querySelector('.backpack');
      if (bp) {
        bp.querySelector('.cnt').textContent = ` ${new Set([...S.journey.walkFound, S.opened]).size} из ${S.journey.plan.length}`;
        bp.classList.add('bounce');
      }
    });
  }
}

function answer(option) {
  S.quizChoice = option;
  const right = option === route.stops[S.opened].question.answer;
  player.play(...(right ? ['phrase_right', 'phrase_photo'] : ['phrase_wrong']));
  render();
}

function completeStop() {
  player.stop();
  const j = S.journey;
  const i = S.opened;
  if (i !== J.active) return;
  const next = {
    ...j,
    found: [...new Set([...j.found, i])],
    walkFound: [...new Set([...j.walkFound, i])],
    position: j.position + 1,
  };
  if (next.position === next.plan.length) next.badge = true;
  setJourney(next);
  refreshCollage();
  if (J.complete) {
    endWalk(true);
  } else {
    go('walk');
    player.play('phrase_found', 'phrase_go');
  }
}

function endWalk(complete) {
  player.stop();
  const j = S.journey;
  S.result = { complete, found: j.plan.filter(i => j.walkFound.includes(i)) };
  setJourney({ ...j, plan: [], position: 0, walkFound: [] });
  S.distance = null;
  G.ahead = null;
  stopTracking();
  go('finale');
  if (complete) player.play('bell', 'finale_trosha'); else player.play('phrase_later');
  if (complete && !S.celebrated.has(-1)) {
    S.celebrated.add(-1);
    celebrate(route.badge, 'Ура!', 'Ты — Юный караванщик!');
  }
}

function backToWalk() { player.stop(); go('walk'); }
function goHome() { player.stop(); go('home'); }
function openAlbum() { player.stop(); go('album'); }

async function resetAlbum() {
  const ok = await ask('Очистить альбом?', 'Все найденные вещи, фото и значок исчезнут, и Троша снова потеряется.', 'Очистить', 'Отмена');
  if (!ok) return;
  player.stop();
  setJourney(newJourney());
  await Photos.clear();
  go('home');
}

function toggleStopStory() {
  const i = S.opened;
  if (player.current) player.stop(); else player.play(Clips.narrator(i), Clips.trosha(i), Clips.task(i));
}

function toggleWalkHint() {
  if (player.current) player.stop(); else player.play('phrase_go');
}

function toggleParentStory() {
  if (player.current === Clips.parent(S.opened)) player.stop(); else player.play(Clips.parent(S.opened));
}

/** Назад: жест «назад» в браузере и на iPhone ведёт себя как кнопка «Назад» в Android. */
window.addEventListener('popstate', () => {
  switch (S.screen) {
    case 'home': return;
    case 'stop': backToWalk(); break;
    case 'walk': pause(); break;
    case 'choose':
      if (S.editing) { S.editing = null; render(); } else goHome();
      break;
    default: goHome();
  }
  if (S.screen !== 'home') history.pushState({ inner: true }, '');
});

/* ================= Праздник ================= */

function celebrate(sticker, title, subtitle, onDone) {
  const colors = ['#d2463c', '#f5c542', '#3e9c6a', '#2f6fb5', '#ec4f8a', '#8e5bd6'];
  let confetti = '';
  for (let k = 0; k < 40; k++) {
    confetti += `<i class="confetti" style="left:${Math.random() * 100}%;background:${colors[k % colors.length]};` +
      `animation-duration:${1.6 + Math.random() * 1.6}s;animation-delay:${Math.random() * 0.5}s"></i>`;
  }
  $overlay.innerHTML = `<div class="celebrate">${confetti}<div class="box">` +
    `<img class="sticker" src="stickers/${sticker}.webp" alt="">` +
    `<div class="t">${esc(title)}</div><div class="s">${esc(subtitle)}</div></div></div>`;
  setTimeout(() => {
    $overlay.innerHTML = '';
    if (onDone) onDone();
  }, 2600);
}

let toastTimer = null;
function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(24px + env(safe-area-inset-bottom));z-index:60;' +
      'background:#3b2415;color:#fff;border-radius:16px;padding:14px 16px;font-size:16px;text-align:center;box-shadow:0 6px 18px rgba(0,0,0,.3)';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/* ================= Фото и коллаж ================= */

/**
 * Фото на память с точек (как PhotoStore.kt): хранятся только в телефоне, в IndexedDB,
 * уменьшенные до 1600 px. Когда у всех найденных вещей есть фото, сам собирается коллаж.
 */
const Photos = {
  db: null,
  urls: new Map(),
  has: new Set(),
  collageUrl: null,
  collageBlob: null,

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('karavan', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos');
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('photos', mode);
      const r = fn(t.objectStore('photos'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  },
  async load() {
    try {
      const keys = await this.tx('readonly', st => st.getAllKeys());
      for (const k of keys) {
        const blob = await this.tx('readonly', st => st.get(k));
        if (!blob) continue;
        if (k === 'collage') { this.collageBlob = blob; this.collageUrl = URL.createObjectURL(blob); }
        else { this.has.add(+k); this.urls.set(+k, URL.createObjectURL(blob)); }
      }
    } catch (_) { /* нет IndexedDB — фото не сохраняются */ }
  },
  url: i => Photos.urls.get(i) || null,
  async save(i, blob) {
    await this.tx('readwrite', st => st.put(blob, String(i)));
    if (this.urls.has(i)) URL.revokeObjectURL(this.urls.get(i));
    this.urls.set(i, URL.createObjectURL(blob));
    this.has.add(i);
  },
  async clear() {
    try { await this.tx('readwrite', st => st.clear()); } catch (_) { /* нечего чистить */ }
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls.clear();
    this.has.clear();
    this.setCollage(null);
  },
  async setCollage(blob) {
    if (this.collageUrl) URL.revokeObjectURL(this.collageUrl);
    this.collageBlob = blob;
    this.collageUrl = blob ? URL.createObjectURL(blob) : null;
    try { await this.tx('readwrite', st => (blob ? st.put(blob, 'collage') : st.delete('collage'))); } catch (_) { /* без сохранения */ }
  },
};

const loadImage = src => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

/** Снимок с камеры или из галереи → JPEG до 1600 px. Браузер сам поворачивает фото по EXIF. */
async function importPhoto(stop, file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    await Photos.save(stop, blob);
    await refreshCollage();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
  } catch (_) {
    toast('Не удалось сохранить фото');
  } finally {
    URL.revokeObjectURL(url);
  }
}

let photoStop = -1;
function pickPhoto(stop, camera) {
  photoStop = stop;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (camera) input.setAttribute('capture', 'environment');
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f && photoStop >= 0) importPhoto(photoStop, f);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

const photosMissing = () => S.journey.found.filter(i => !Photos.has.has(i)).length;
const findsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'находке' : 'находкам');

/** Коллаж «Мои находки с Трошей» на листе A4 — тот же макет, что Collage.kt в Android. */
async function refreshCollage() {
  const j = S.journey;
  const found = route.default_order.filter(i => j.found.includes(i))
    .concat(j.found.filter(i => !route.default_order.includes(i)).sort((a, b) => a - b));
  if (!found.length || found.some(i => !Photos.has.has(i))) {
    await Photos.setCollage(null);
    return;
  }
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const blob = await renderCollage(found, j.badge);
    await Photos.setCollage(blob);
  } catch (_) {
    await Photos.setCollage(null);
  }
}

/**
 * Раскладка коллажа на листе A4: из 1–4 столбцов берём ту, где фото крупнее всего
 * (а из почти равных — с большим числом рядов).
 * Тот же расчёт — в Collage.kt Android-приложения.
 */
const COLLAGE = { W: 1654, H: 2339, MARGIN: 70, HEADER: 300, FOOTER: 340, GAP: 40, PAD: 22 };
const captionSize = photo => Math.max(28, Math.min(54, Math.round(photo * 0.08)));
const captionHeight = photo => Math.round(captionSize(photo) * 2.7);

function collageLayout(n) {
  const { W, H, MARGIN, HEADER, FOOTER, GAP, PAD } = COLLAGE;
  const gw = W - 2 * MARGIN, gh = H - HEADER - FOOTER;
  const options = [];
  for (let cols = 1; cols <= Math.min(4, n); cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (gw - (cols - 1) * GAP) / cols, cellH = (gh - (rows - 1) * GAP) / rows;
    let photo = Math.floor(Math.min(cellW, cellH) - 2 * PAD);
    while (photo > 0 && photo + 2 * PAD + captionHeight(photo) > cellH) photo -= 2;
    options.push({ cols, rows, cellW, cellH, photo });
  }
  // Почти такие же крупные фото, но больше рядов — лист заполнен, а не пустой сверху и снизу.
  const top = Math.max(...options.map(o => o.photo));
  return options.filter(o => o.photo >= top * 0.9).sort((a, b) => b.rows - a.rows || b.photo - a.photo)[0];
}

async function renderCollage(found, badge) {
  const { W, H, MARGIN, HEADER, FOOTER, GAP, PAD } = COLLAGE;
  const L = collageLayout(found.length);
  const PHOTO = L.photo, CARD_W = PHOTO + 2 * PAD, CARD_H = PHOTO + 2 * PAD + captionHeight(PHOTO);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (size, bold) => `${bold ? 700 : 400} ${size}px Rubik, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = '#e8d3b0';
  g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.fillStyle = '#d2463c'; g.font = font(104, true);
  g.fillText('Маленький караван', W / 2, 150);
  g.fillStyle = '#3b2415'; g.font = font(54);
  g.fillText(`Мои находки с Трошей · ${found.length} ${placesWord(found.length)}`, W / 2, 238);

  const fit = (img, x, y, w, h) => {
    const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
    g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  };
  const round = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  };

  for (let k = 0; k < found.length; k++) {
    const i = found[k];
    const stop = route.stops[i];
    const row = Math.floor(k / L.cols), col = k % L.cols;
    // Неполный последний ряд — по центру.
    const inRow = Math.min(L.cols, found.length - row * L.cols);
    const rowLeft = MARGIN + (L.cols - inRow) * (L.cellW + GAP) / 2;
    const left = rowLeft + col * (L.cellW + GAP) + (L.cellW - CARD_W) / 2;
    const top = HEADER + row * (L.cellH + GAP) + (L.cellH - CARD_H) / 2;
    const [photo, st] = await Promise.all([loadImage(Photos.url(i)), loadImage(`stickers/${stop.sticker}.webp`).catch(() => null)]);
    g.save();
    // Карточки чуть наклонены в разные стороны — как фото, приклеенные в альбом.
    g.translate(left + CARD_W / 2, top + CARD_H / 2);
    g.rotate((k % 2 === 0 ? -2.5 : 2) * Math.PI / 180);
    g.translate(-(left + CARD_W / 2), -(top + CARD_H / 2));
    g.fillStyle = 'rgba(60,30,10,0.24)'; round(left + 6, top + 10, CARD_W, CARD_H, 18); g.fill();
    g.fillStyle = '#fff'; round(left, top, CARD_W, CARD_H, 18); g.fill();
    const side = Math.min(photo.naturalWidth, photo.naturalHeight);
    g.drawImage(photo, (photo.naturalWidth - side) / 2, (photo.naturalHeight - side) / 2, side, side, left + PAD, top + PAD, PHOTO, PHOTO);
    const fs = captionSize(PHOTO);
    g.fillStyle = '#3b2415'; g.font = font(fs, true);
    wrapText(g, stop.title, left + CARD_W / 2, top + PAD + PHOTO + fs * 1.35, PHOTO, Math.round(fs * 1.2), 2);
    const ss = Math.round(CARD_W * 0.32);
    if (st) fit(st, left + CARD_W - ss * 0.85, top - ss * 0.2, ss, ss);
    g.restore();
  }

  const footTop = H - FOOTER;
  const art = FOOTER - 40;
  const trosha = await loadImage('stickers/trosha.webp').catch(() => null);
  if (trosha) fit(trosha, MARGIN, footTop + 20, art, art);
  if (badge) {
    const b = await loadImage(`stickers/${route.badge}.webp`).catch(() => null);
    if (b) fit(b, W - MARGIN - art, footTop + 20, art, art);
    g.fillStyle = '#d2463c'; g.font = font(60, true);
    g.fillText('Юный караванщик!', W / 2, footTop + FOOTER / 2 + 20);
  } else {
    g.fillStyle = '#7a6150'; g.font = font(54);
    g.fillText('Продолжение следует…', W / 2, footTop + FOOTER / 2 + 20);
  }
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
}

function wrapText(g, text, cx, y, maxW, lineH, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (g.measureText(`${last}…`).width > maxW && last.length) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  lines.forEach((l, k) => g.fillText(l, cx, y + k * lineH));
}

/** Поделиться коллажем: меню iPhone/Android «Сохранить изображение», мессенджеры; иначе — скачать файл. */
async function shareCollage() {
  const blob = Photos.collageBlob;
  if (!blob) return;
  const file = new File([blob], 'malenkiy-karavan.jpg', { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Маленький караван' }); } catch (_) { /* отменили */ }
    return;
  }
  const a = document.createElement('a');
  a.href = Photos.collageUrl;
  a.download = 'malenkiy-karavan.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ================= Экраны ================= */

const sticker = (name, cls = '', size = '') =>
  `<img class="sticker ${cls}" src="stickers/${name}.webp" alt="" ${size ? `style="width:${size}px;height:${size}px"` : ''}>`;
const mystery = (size = 40, font = 22) => `<div class="mystery" style="width:${size}px;height:${size}px;font-size:${font}px">?</div>`;

function stickerRow(stops) {
  return `<div class="stickers">${stops.map(i => J.isFound(i) ? sticker(route.stops[i].sticker) : mystery()).join('')}</div>`;
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  if (S.screen === 'home') render();
});

const APP_URL = 'https://qwest65.github.io/malenkiy-karavan-web/';
/** Встроенные браузеры Telegram, ВК, MAX, Instagram и т. п.: там часто нет геопозиции и звука. */
const inAppBrowser = /Telegram|VKClient|vkontakte|Instagram|FBAN|FBAV|OKApp|OneMe|; wv\)/i.test(navigator.userAgent);

/** Ссылка, открывающая прогулку в обычном браузере: Safari на iPhone, браузер по умолчанию на Android. */
function browserLink() {
  if (isIOS) return `x-safari-${APP_URL}`;
  return `intent://${APP_URL.replace('https://', '')}#Intent;scheme=https;end`;
}

const mustOpenInBrowser = () => inAppBrowser && !standalone;

/**
 * Геопозиция не пришла — подсказка на прогулке «откройте в Safari / браузере». Чаще всего это
 * встроенный браузер мессенджера: MAX, например, подписывается как обычный Safari, и по подписи
 * его не узнать. Поэтому смотрим только на то, есть ли координаты.
 */
function geoBrowserHelp() {
  if (standalone || S.fix) return '';
  const failed = GEO.status === 'denied' || GEO.status === 'unsupported' || Date.now() - GEO.since > 45000;
  if (!failed) return '';
  // На Android ссылка intent:// открывает браузер по умолчанию (Chrome, Яндекс…), поэтому без названия.
  const where = isIOS ? 'Safari' : 'браузере';
  const menu = isIOS ? '⋯ или ☰' : '⋮ или ☰';
  return `<div class="hint geo-help" style="background:#fff1c9;color:#7a4b00">
    Здесь телефон не даёт Троше узнать, где вы. Открыли из мессенджера — откройте прогулку в ${where}.
    <a class="btn" href="${browserLink()}" style="display:grid;place-items:center;text-decoration:none;min-height:52px;font-size:18px;margin-top:8px">${isIOS ? '🧭' : '🌐'} Открыть в ${where}</a>
    <div style="font-size:13px;margin-top:6px">Не открылось? В меню ${menu} мессенджера выберите «Открыть в ${where}».</div></div>`;
}

function installHint() {
  // Открыто в Telegram, ВК или с экрана «Домой» iPhone — там геопозиция не работает: ведём в браузер.
  if (mustOpenInBrowser()) {
    return `<div class="hint" style="background:#fff1c9;color:#7a4b00">
      <b>Откройте прогулку в ${isIOS ? 'Safari' : 'браузере'}</b> — здесь телефон не даёт Троше узнать, где вы.
      <div style="margin-top:10px"><a class="btn" href="${browserLink()}" style="display:grid;place-items:center;text-decoration:none">Открыть в ${isIOS ? 'Safari' : 'браузере'}</a></div>
      <div style="margin-top:8px;font-size:14px">Не открылось? Нажмите ⋯ или «Поделиться» и выберите «Открыть в ${isIOS ? 'Safari' : 'браузере'}».</div></div>`;
  }
  let hidden = false;
  try { hidden = localStorage.getItem(HINT_KEY) === 'hidden'; } catch (_) { /* нет хранилища */ }
  if (standalone || hidden) return '';
  // На iPhone — тихая строчка внизу и только со второго открытия: кнопки установки iOS не даёт.
  if (isIOS) {
    let opens = 0;
    try { opens = +localStorage.getItem(OPENS_KEY) || 0; } catch (_) { /* нет хранилища */ }
    if (opens < 2) return '';
    return `<div class="hint quiet-hint"><button class="x" data-act="hideHint" aria-label="Скрыть">✕</button>
      📲 Прогулку можно поставить на экран «Домой»: в Safari «Поделиться» → «На экран „Домой“».</div>`;
  }
  if (installEvent) {
    return `<div class="hint"><button class="x" data-act="hideHint" aria-label="Скрыть">✕</button>
      <b>Установите приложение</b> — оно будет открываться с экрана телефона, даже без интернета.
      <div style="margin-top:10px"><button class="btn soft" data-act="install">📲 Установить</button></div></div>`;
  }
  return '';
}

function offlineProgress() {
  const { done, total } = OFFLINE;
  if (!total) return '';
  if (done >= total) {
    return Date.now() < OFFLINE.hideAt ? '<div class="offline-bar done">✅ Готово — прогулка работает без интернета</div>' : '';
  }
  const pct = Math.floor(done * 100 / total);
  const what = OFFLINE.update ? 'Загружаем новую версию' : 'Сохраняем прогулку в телефон, чтобы работала без интернета';
  return `<div class="offline-bar"><div>📥 ${what}: ${pct}%</div><div class="track"><div style="width:${pct}%"></div></div></div>`;
}

function showOfflineProgress() {
  const el = document.getElementById('offline-progress');
  if (el) el.innerHTML = offlineProgress();
}

function homeScreen() {
  const j = S.journey;
  return `<div class="page">
    <h1 class="h1">Маленький караван</h1>
    ${mustOpenInBrowser() ? installHint() : ''}
    ${sticker('trosha', 'trosha-home')}
    <div class="panel">
      <div class="h2">${esc(route.title)}</div>
      <p style="font-size:17px">${esc(route.subtitle)}</p>
      <div class="muted" style="font-size:15px">${esc(planSummary(route.default_order))}</div>
      ${j.found.length ? `<div class="red bold" style="font-size:17px">В альбоме ${j.found.length} из ${route.stops.length}</div>
        ${stickerRow(route.stops.map((_, i) => i))}` : ''}
    </div>
    ${J.inProgress ? `
      <div class="panel gold">
        <div class="bold" style="font-size:20px">⏸ Прогулка на паузе</div>
        <div style="font-size:16px">Пройдено точек: ${j.position} из ${j.plan.length}</div>
      </div>
      <button class="btn" data-act="resume">Продолжить прогулку</button>
      <button class="btn soft" data-act="finish">Завершить прогулку</button>`
    : `<button class="btn" data-act="choose">Начать прогулку</button>`}
    <button class="btn soft" data-act="album">Мой альбом</button>
    ${mustOpenInBrowser() ? '' : installHint()}
    ${j.found.length || j.badge ? `<button class="link" data-act="reset">Очистить альбом</button>` : ''}
    <div id="offline-progress">${offlineProgress()}</div>
    <a class="link muted" href="site/" style="font-size:14px;min-height:0;padding:4px">О проекте «Маленький караван»</a>
    <button class="link muted" data-act="about" style="font-size:12px;opacity:.7;min-height:0;padding:4px">Веб-версия ${APP_VERSION}</button>
  </div>`;
}

function chooseScreen() {
  if (S.editing) return builderScreen();
  return `<div class="page">
    <div class="back-row"><button class="link" data-act="home">← Назад</button></div>
    <h1 class="h1">Куда пойдём?</h1>
    <p class="sub">Выберите готовый маршрут или соберите свой.</p>
    ${route.presets.map((p, k) => `
      <div class="panel">
        <div class="preset-head"><div class="emoji">${p.emoji}</div>
          <div><div class="t">${esc(p.title)}</div>${p.subtitle ? `<div class="s">${esc(p.subtitle)}</div>` : ''}</div></div>
        ${stickerRow(p.stops)}
        <div style="font-size:15px">${esc(planSummary(p.stops))}</div>
        <div class="row">
          <button class="btn grow" data-act="go" data-preset="${k}">Идём!</button>
          <button class="btn out" data-act="edit" data-preset="${k}">Изменить</button>
        </div>
      </div>`).join('')}
    <button class="btn soft" data-act="edit" data-preset="-1">✏️ Собрать свой маршрут</button>
  </div>`;
}

function thumb(i) {
  return J.isFound(i) ? sticker(route.stops[i].sticker, 'thumb') : mystery(40, 22);
}

function builderScreen() {
  const plan = S.editing.plan;
  const rest = route.stops.map((_, i) => i).filter(i => !plan.includes(i));
  return `<div class="page">
    <div class="back-row"><button class="link" data-act="unedit">← К маршрутам</button></div>
    <h1 class="h1">Свой маршрут</h1>
    <p class="sub">Добавляйте точки из списка ниже и меняйте порядок стрелками.</p>
    ${plan.length ? `<button class="link" data-act="clearPlan" style="color:var(--ink)">Очистить</button>`
      : `<div class="red bold" style="font-size:17px">Пока пусто — нажмите ＋ у нужных точек</div>`}
    ${plan.map((i, pos) => `
      <div class="plan-card">
        <div class="n">${pos + 1}</div>${thumb(i)}
        <div class="t">${esc(route.stops[i].title)}${J.isFound(i) ? '<small>Уже в альбоме</small>' : ''}</div>
        <button class="small" data-act="up" data-pos="${pos}" ${pos === 0 ? 'disabled' : ''}>↑</button>
        <button class="small" data-act="down" data-pos="${pos}" ${pos === plan.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="small" data-act="remove" data-pos="${pos}">✕</button>
      </div>`).join('')}
    ${rest.length ? `<div class="bold" style="font-size:20px;width:100%">Добавить точку</div>
      ${rest.map(i => `<button class="add-card" data-act="add" data-stop="${i}">${thumb(i)}<span class="t">${esc(route.stops[i].title)}</span><span class="small" style="display:grid;place-items:center">＋</span></button>`).join('')}` : ''}
    <div class="bold ${plan.length ? '' : 'red'}" style="font-size:17px">${plan.length ? esc(planSummary(plan)) : 'Выберите хотя бы одну точку'}</div>
    <button class="btn" data-act="goPlan" ${plan.length ? '' : 'disabled'}>Идём!</button>
  </div>`;
}

function walkScreen() {
  const j = S.journey;
  const active = J.active;
  if (active == null) return '';
  const stop = route.stops[active];
  return `<div class="walk-top">
      <div class="bar">
        <button class="pill" data-act="pause">⏸ Пауза</button>
        <span style="flex:1"></span>
        <button class="round north" data-act="north" id="north-btn" hidden aria-label="Повернуть карту на север"><span>▲<b>С</b></span></button>
        <button class="round" data-act="follow" id="follow-btn" ${M.following ? 'hidden' : ''}>🧭</button>
        <button class="round" data-act="fit">⤢</button>
      </div>
      <div id="banner"></div>
      <div id="route-src" class="route-src" hidden></div>
    </div>
    <div class="walk-panel" id="walk-panel">
      <button class="grip" data-act="panel" aria-label="Свернуть или развернуть"><span></span></button>
      <div id="geo-help"></div>
      ${S.panelOpen ? `
        ${stickerRow(j.plan)}
        <div class="target">Точка ${j.position + 1} из ${j.plan.length}: ${esc(stop.title)}</div>
        <div id="dist-big"></div>
        <div style="font-size:16px">🤝 Держи взрослого за руку</div>
        <div class="row">
          <button class="round" data-act="walkHint" data-speaker="walk">${player.current ? '⏹' : '🔊'}</button>
          <button class="btn grow" data-act="arrive">🔔 Мы на месте!</button>
        </div>
        <div class="links">
          <button class="link" data-act="skip">Пропустить точку</button>
          <button class="link" data-act="finish">Завершить прогулку</button>
        </div>`
      : `<div class="row"><div class="steps-summary" id="dist-small"></div><button class="round" data-act="arrive">🔔</button></div>`}
    </div>`;
}

/**
 * Плашка навигатора (NavigationBanner в Screens.kt): куда повернуть и через сколько метров.
 * Рядом с точкой или без пути по улицам — стрелка прямо на точку с учётом компаса.
 */
function updateBanner() {
  const el = document.getElementById('banner');
  if (!el) return;
  const d = S.distance, here = S.shown, target = J.active;
  if (d == null || !here || target == null) { el.innerHTML = ''; return; }
  const stop = route.stops[target];
  const ins = S.instruction;
  const near = d <= NEAR_METERS;
  let arrow = '↑', rotation = 0, title, subtitle;
  const heading = freshHeading();
  if (heading != null && (near || !ins)) {
    const steps = kidSteps(d);
    rotation = angleDelta(heading, bearingDegrees([here.lat, here.lon], [stop.lat, stop.lon]));
    title = near ? 'Точка рядом — иди по стрелке' : 'Иди по стрелке к точке';
    subtitle = `≈ ${steps} ${stepsWord(steps)} · ${formatDistance(d)}`;
  } else if (ins && ins.turn) {
    arrow = ins.turn === 'u_turn' ? '↩' : '↑';
    rotation = TURN_ROTATE[ins.turn];
    title = ins.inMeters < NOW_METERS ? `Сейчас ${TURN_WORD[ins.turn]}` : `Через ${formatDistance(ins.inMeters)} ${TURN_WORD[ins.turn]}`;
    subtitle = `До точки ${formatDistance(d)}`;
  } else if (ins) {
    title = `Прямо ${formatDistance(ins.inMeters)}`;
    subtitle = 'и мы у точки';
  } else if (near) {
    arrow = '📍';
    title = 'Точка рядом!';
    subtitle = `Смотри по сторонам · ${formatDistance(d)}`;
  } else {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="banner"><div class="arrow" style="transform:rotate(${Math.round(rotation)}deg)">${arrow}</div>` +
    `<div><div class="t">${esc(title)}</div><div class="s">${esc(subtitle)}</div></div></div>`;
}

/** Обновление прогулки без перерисовки всего экрана: каждые несколько секунд приходит GPS. */
function updateWalkView() {
  if (S.screen !== 'walk') return;
  const d = S.distance;
  const big = document.getElementById('dist-big');
  const small = document.getElementById('dist-small');
  const help = document.getElementById('geo-help');
  if (help) {
    const html = geoBrowserHelp();
    if (help.dataset.html !== html) { help.dataset.html = html; help.innerHTML = html; }
  }
  if (big) {
    big.innerHTML = d != null
      ? `<div class="steps-big">≈ ${kidSteps(d)} ${stepsWord(kidSteps(d))}</div><div class="muted" style="font-size:14px">${formatDistance(d)} для взрослых</div>`
      : `<div class="muted" style="font-size:${geoMessage().length > 20 ? 16 : 20}px;line-height:1.35">${esc(geoMessage())}</div>`;
  }
  if (small) {
    small.textContent = d != null ? `≈ ${kidSteps(d)} ${stepsWord(kidSteps(d))}` : (GEO.status === 'denied' ? 'Нажмите 🔔 у точки' : 'Ищем, где мы…');
    small.style.color = d != null ? '' : 'var(--muted)';
  }
  updateBanner();
  const src = document.getElementById('route-src');
  if (src) {
    const text = {
      leg: 'Путь: линия маршрута',
      streets: 'Путь: по улицам центра',
      osrm: 'Путь: через интернет (OSRM)',
      valhalla: 'Путь: через интернет (Valhalla)',
      pending: 'Путь: спрашиваем у сервиса маршрутов…',
      failed: 'Путь: сервис маршрутов не ответил — показана прямая',
      offline: 'Путь: нет интернета — показана прямая',
    }[G.source];
    src.textContent = text || '';
    src.hidden = !text || d == null;
  }
  const fb = document.getElementById('follow-btn');
  if (fb) fb.hidden = M.following;
  updateNorth();
  drawLive();
}

function stopScreen() {
  const i = S.opened;
  const stop = route.stops[i];
  const j = S.journey;
  const last = j.position === j.plan.length - 1;
  const q = stop.question;
  const choice = S.quizChoice;
  const answeredRight = choice != null && choice === q.answer;
  const walkFound = new Set(j.walkFound);
  if (S.revealed && S.celebrated.has(i)) walkFound.add(i);
  return `<div class="page">
    <div class="back-row">
      <button class="link" data-act="backToWalk">← К карте</button>
      <div class="backpack"><span class="ico">🎒</span><span class="cnt"> ${walkFound.size} из ${j.plan.length}</span></div>
    </div>
    <div class="muted" style="font-size:15px">Точка ${j.position + 1} из ${j.plan.length}</div>
    <h1 class="h1" style="font-size:26px">${esc(stop.title)}</h1>
    <div class="found-item">${S.revealed ? sticker(stop.sticker) : mystery(140, 80)}</div>
    ${S.revealed ? `<div class="red bold" style="font-size:24px;text-align:center">Нашлось: ${esc(stop.item)}!</div>`
      : `<button class="link" data-act="reveal">Показать находку</button>`}
    <div class="panel"><div class="who">Рассказчик</div><p>${esc(stop.narrator)}</p></div>
    <div class="panel"><div class="who">${sticker('trosha')}Троша</div><p>${esc(stop.trosha)}</p></div>
    <div class="panel gold">
      <div class="quiz-q">❓ ${esc(q.text)}</div>
      ${S.optionOrder.map(o => {
        const picked = choice === o;
        const cls = picked && o === q.answer ? 'right' : picked ? 'wrong' : answeredRight ? 'off' : '';
        return `<button class="opt ${cls}" data-act="answer" data-opt="${o}" ${answeredRight && !picked ? 'disabled' : ''}>${esc(q.options[o])}</button>`;
      }).join('')}
      ${answeredRight ? '<div class="green bold" style="font-size:20px">⭐ Правильно! Молодец!</div>'
        : choice != null ? '<div class="red" style="font-size:18px">Не совсем — попробуй ещё раз!</div>' : ''}
    </div>
    ${stop.activity ? `<div class="panel"><div class="who">🎲 Игра</div><p>${esc(stop.activity)}</p></div>` : ''}
    <div class="panel">
      <div class="who">📷 Фото на память</div>
      ${Photos.url(i) ? `<img class="stop-photo" src="${Photos.url(i)}" alt="Фото с точки">`
        : '<p style="font-size:16px">Сфотографируйтесь здесь вместе — из фото сложится коллаж в альбоме.</p>'}
      <div class="row">
        <button class="btn soft" data-act="camera" data-stop="${i}" style="min-height:50px;font-size:17px">${Photos.url(i) ? 'Переснять' : '📸 Камера'}</button>
        <button class="btn soft" data-act="gallery" data-stop="${i}" style="min-height:50px;font-size:17px">🖼 Из галереи</button>
      </div>
    </div>
    <div class="panel kraft">
      <button class="parent-toggle" data-act="parent">${S.parentOpen ? '▾' : '▸'} Для взрослых</button>
      ${S.parentOpen ? `<p style="font-size:16px">${esc(stop.parent)}</p>
        <button class="btn soft" data-act="parentStory" data-speaker="parent">${player.current === Clips.parent(i) ? 'Остановить' : 'Подробная история голосом'}</button>` : ''}
    </div>
    <div class="row">
      <button class="round" data-act="story" data-speaker="stop">${player.current ? '⏹' : '🔊'}</button>
      <button class="btn grow" data-act="complete">${last ? 'Ура! Завершить прогулку' : 'Готово! Идём дальше'}</button>
    </div>
  </div>`;
}

function finaleScreen() {
  const r = S.result || { complete: false, found: [] };
  return `<div class="page">
    ${r.complete ? `
      <div class="red" style="font-size:40px;font-weight:900">Ура!</div>
      ${sticker(route.badge, 'badge-big')}
      <h1 class="h1" style="font-size:28px">Ты — Юный караванщик!</h1>
      <p class="sub" style="color:var(--ink);font-size:18px">${esc(route.finale.trosha)}</p>`
    : `<h1 class="h1">Прогулка окончена</h1>
      ${sticker('trosha', '', 200)}
      <p class="sub" style="color:var(--ink);font-size:18px">Ничего, продолжим в другой раз! Остальные вещи Троша подождёт.</p>`}
    <div class="panel">
      ${r.found.length ? `<div class="bold" style="font-size:17px">Сегодня нашли:</div>
        <div class="stickers">${r.found.map(i => sticker(route.stops[i].sticker, '', 56)).join('')}</div>`
      : '<div class="muted" style="font-size:17px">Сегодня ничего не нашли</div>'}
    </div>
    <button class="btn" data-act="album">Мой альбом</button>
    <button class="btn soft" data-act="home">На главную</button>
  </div>`;
}

function albumScreen() {
  const j = S.journey;
  return `<div class="page">
    <div class="back-row"><button class="link" data-act="home">← Назад</button></div>
    <h1 class="h1">Мой альбом</h1>
    <div class="muted" style="font-size:17px">Найдено ${j.found.length} из ${route.stops.length}</div>
    ${Photos.collageUrl ? `<div class="panel">
        <div class="bold" style="font-size:20px">🖼 Коллаж прогулки</div>
        <img class="collage" src="${Photos.collageUrl}" alt="Коллаж из фото прогулки">
        <button class="btn soft" data-act="share">Поделиться или сохранить</button>
      </div>`
    : j.found.length ? `<div class="panel gold"><p style="font-size:16px">Добавьте фото ещё к ${photosMissing()} ${findsWord(photosMissing())} — и коллаж соберётся сам.</p></div>` : ''}
    <div class="album">
      ${route.stops.map((s, i) => {
        const found = J.isFound(i);
        const photo = found ? Photos.url(i) : null;
        return `<div class="album-card">
          ${photo ? `<div class="album-photo"><img src="${photo}" alt="Фото: ${esc(s.title)}">${sticker(s.sticker, 'corner')}</div>` : sticker(s.sticker, found ? '' : 'locked')}
          <div class="t ${found ? '' : 'muted'}">${found ? esc(s.item) : 'Ещё не нашли'}</div>
          <div class="s">${esc(s.title)}</div>
          ${found ? `<div class="row" style="justify-content:center;gap:6px">
            <button class="small" data-act="camera" data-stop="${i}" aria-label="Снять фото">📸</button>
            <button class="small" data-act="gallery" data-stop="${i}" aria-label="Фото из галереи">🖼</button></div>` : ''}
        </div>`;
      }).join('')}
      <div class="album-card wide">${sticker(route.badge, j.badge ? '' : 'locked')}
        <div class="t" style="font-size:18px">${j.badge ? 'Юный караванщик' : 'Значок — за прогулку, пройденную до конца'}</div></div>
    </div>
  </div>`;
}

/** Нижняя панель прогулки сворачивается сама, если её не трогать: карте нужно больше места. */
const PANEL_HIDE_MS = 5000;
let panelTimer = null;

function schedulePanelHide() {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    panelTimer = null;
    if (S.screen === 'walk' && S.panelOpen) { S.panelOpen = false; render(); }
  }, PANEL_HIDE_MS);
}

function render() {
  const walking = S.screen === 'walk';
  if (walking && S.panelOpen) {
    if (!panelTimer) schedulePanelHide();
  } else {
    clearTimeout(panelTimer);
    panelTimer = null;
  }
  document.body.classList.toggle('walking', walking);
  $mapScreen.hidden = !walking;
  keepAwake(walking);
  const screens = { home: homeScreen, choose: chooseScreen, walk: walkScreen, stop: stopScreen, finale: finaleScreen, album: albumScreen };
  $app.innerHTML = screens[S.screen]();
  if (walking) {
    ensureMap();
    if (M.map) {
      M.map.resize();
      drawMap();
    }
    updateGuidance();
    updateWalkView();
  } else if (S.screen !== 'stop') {
    window.scrollTo(0, 0);
  }
}

/* ================= Нажатия ================= */

$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (S.panelOpen && b.closest('#walk-panel')) schedulePanelHide();
  const d = b.dataset;
  const ed = S.editing;
  switch (d.act) {
    case 'choose': openChooser(); break;
    case 'resume': resumeWalk(); break;
    case 'finish': finishWalk(); break;
    case 'album': openAlbum(); break;
    case 'home': goHome(); break;
    case 'reset': resetAlbum(); break;
    case 'go': startWalk(route.presets[+d.preset].stops); break;
    case 'edit': S.editing = { plan: +d.preset >= 0 ? route.presets[+d.preset].stops.slice() : [] }; render(); window.scrollTo(0, 0); break;
    case 'unedit': S.editing = null; render(); break;
    case 'clearPlan': ed.plan = []; render(); break;
    case 'add': ed.plan.push(+d.stop); render(); break;
    case 'remove': ed.plan.splice(+d.pos, 1); render(); break;
    case 'up': { const p = +d.pos; [ed.plan[p - 1], ed.plan[p]] = [ed.plan[p], ed.plan[p - 1]]; render(); break; }
    case 'down': { const p = +d.pos; [ed.plan[p + 1], ed.plan[p]] = [ed.plan[p], ed.plan[p + 1]]; render(); break; }
    case 'goPlan': startWalk(ed.plan); break;
    case 'pause': pause(); break;
    case 'follow': follow(); break;
    case 'north': north(); break;
    case 'fit': fitAll(); updateWalkView(); break;
    case 'panel': S.panelOpen = !S.panelOpen; render(); break;
    case 'walkHint': toggleWalkHint(); break;
    case 'arrive': arrive(); break;
    case 'skip': skipStop(); break;
    case 'backToWalk': backToWalk(); break;
    case 'reveal': reveal(); break;
    case 'answer': answer(+d.opt); break;
    case 'parent': S.parentOpen = !S.parentOpen; render(); break;
    case 'parentStory': toggleParentStory(); break;
    case 'story': toggleStopStory(); break;
    case 'complete': completeStop(); break;
    case 'camera': pickPhoto(+d.stop, true); break;
    case 'gallery': pickPhoto(+d.stop, false); break;
    case 'share': shareCollage(); break;
    case 'hideHint': try { localStorage.setItem(HINT_KEY, 'hidden'); } catch (_) { /* нет хранилища */ } render(); break;
    case 'about': ask(`Веб-версия ${APP_VERSION}`, `Браузер: ${navigator.userAgent}${GEO_DIAG.error ? `\nГеопозиция: ${GEO_DIAG.error}` : ''}`, 'Понятно', 'Закрыть'); break;
    case 'install': if (installEvent) { installEvent.prompt(); installEvent = null; render(); } break;
  }
});

/** Свайп по нижней панели прогулки: вниз — свернуть, вверх — развернуть. */
let swipeY = null;
$app.addEventListener('touchstart', e => {
  if (!e.target.closest('#walk-panel')) return;
  swipeY = e.touches[0].clientY;
  if (S.panelOpen) schedulePanelHide();
}, { passive: true });
$app.addEventListener('touchend', e => {
  if (swipeY == null) return;
  const dy = e.changedTouches[0].clientY - swipeY;
  swipeY = null;
  if (dy > 40 && S.panelOpen) { S.panelOpen = false; render(); }
  else if (dy < -40 && !S.panelOpen) { S.panelOpen = true; render(); }
}, { passive: true });

/* ================= Запуск ================= */

async function boot() {
  const [r, p, st] = await Promise.all([
    fetch('data/route.json').then(x => x.json()),
    fetch('data/paths.json').then(x => x.json()),
    fetch('data/streets.json').then(x => x.json()).catch(() => null),
  ]);
  if (st && st.nodes && st.edges) streets = new StreetGraph(st.nodes, st.edges);
  route = r;
  if (!route.presets || !route.presets.length) {
    route.presets = [{ emoji: '🐫', title: 'Весь маршрут', subtitle: '', stops: route.default_order }];
  }
  if (p.route === route.id) {
    for (const leg of p.legs) {
      const path = new WalkPath(leg.points.map(pt => [pt[1], pt[0]]));
      legs.set(`${leg.from}-${leg.to}`, path);
      legs.set(`${leg.to}-${leg.from}`, path.reversed());
    }
  }
  S.journey = loadJourney();
  try { localStorage.setItem(OPENS_KEY, String((+localStorage.getItem(OPENS_KEY) || 0) + 1)); } catch (_) { /* нет хранилища */ }
  await Photos.load();
  history.replaceState({ inner: false }, '');
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Обновление приложения: новая версия приходит в фоне — на главном экране перезапускаемся сами.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('message', e => {
      if (!e.data || e.data.type !== 'offline-progress') return;
      OFFLINE.done = e.data.done;
      OFFLINE.total = e.data.total;
      OFFLINE.update = hadController;
      if (OFFLINE.done >= OFFLINE.total) {
        OFFLINE.hideAt = Date.now() + 5000;
        setTimeout(showOfflineProgress, 5100);
      }
      showOfflineProgress();
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && S.screen === 'home') location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => { /* без офлайна */ });
  }
}

boot().catch(() => {
  $app.innerHTML = '<div class="page"><h1 class="h1">Не получилось открыть</h1><p class="sub">Проверьте интернет и обновите страницу.</p></div>';
});
