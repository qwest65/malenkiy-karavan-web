#!/usr/bin/env python3
"""Карта улиц Троицка и пешеходные линии маршрута «Маленького каравана».

1. Скачивает из OpenStreetMap (Overpass API) дороги и дорожки всего города — тот же
   квадрат 20 × 20 км, что и своя карта (tools/build_map.py).
2. Оставляет только то, где ходят с детьми: улицы, тротуары, переходы, пешеходные
   улицы и дорожки скверов и площадей. Внутриквартальные проезды, парковки, тропинки
   и дорожки во дворах выбрасываются — дворы бывают закрыты.
   Главные улицы, тротуары и скверы «дешевле» переулков, а грунтовки ещё дороже
   (walk_factor): путь выходит чуть длиннее, но идёт по знакомым улицам.
3. Сохраняет граф в data/streets.json: по нему прогулка прямо на телефоне,
   без интернета, строит путь «от меня до точки» из любого места города
   и перестраивает его, если свернули.
4. Тем же алгоритмом строит линии между любыми двумя точками маршрута
   в data/paths.json.
5. Рисует картинку-проверку tools/preview/route-preview.png: все линии маршрута
   поверх улиц, выброшенные дворовые дорожки — бледным.

Координаты точек берутся из data/route.json (поля lat и lon).

    pip install matplotlib
    python3 tools/build_streets.py

Запускается в GitHub Actions (.github/workflows/paths.yml), когда меняется data/route.json.
Файлы data/paths.json и data/streets.json потом можно положить и в Android-приложение
(app/src/main/assets/kids/) — формат тот же.
"""
import heapq
import json
import math
import os
import pathlib
import time
import urllib.parse
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
ROUTE = REPO / "data/route.json"
STREETS = REPO / "data/streets.json"
PATHS = REPO / "data/paths.json"
PREVIEW = REPO / "tools/preview/route-preview.png"

OVERPASS = [
    os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter"),
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "MalenkiyKaravan-build/1.0 (+https://github.com/qwest65/malenkiy-karavan-web)"
# Улицы берём на квадрат вокруг середины маршрута, км — как своя карта: весь город с окраинами,
# чтобы путь от дома до первой точки строился по тем же правилам и без интернета.
AREA_KM = 20
# Для картинки-проверки: запас вокруг точек маршрута, градусы (~500 м).
MARGIN = 0.005
# Узлы на изгибах улиц, отстоящие от прямой меньше чем на столько метров, выбрасываются: файл меньше.
SIMPLIFY_M = 2.0

# «Цена» улицы — во сколько раз путь по ней дороже его длины. Главные улицы — ×1;
# жилые улицы и переулки дороже: путь по ним выбирается, только если в обход заметно длиннее.
MAIN_ROADS = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"}
MINOR_ROADS = {"residential": 1.6, "unclassified": 1.8, "living_street": 1.8, "road": 1.8}
# С тротуаром вдоль (sidewalk=both/left/right) жилая улица почти как главная.
SIDEWALK_ROAD = 1.2
# Грунт, гравий, щебёнка и т. п. — ещё дороже, во столько раз.
UNPAVED = {"unpaved", "ground", "dirt", "earth", "mud", "sand", "grass", "gravel", "fine_gravel",
           "compacted", "pebblestone", "rock", "grass_paver", "woodchips"}
UNPAVED_FACTOR = 1.5
OPEN_SPACE = {("leisure", "park"), ("leisure", "garden"), ("place", "square"), ("landuse", "recreation_ground")}

EARTH = 6_371_008.8

# Скверы, по дорожкам которых ведём, даже если в OpenStreetMap они не отмечены как сквер.
# Обведены по маршруту, нарисованному на месте: от камня к собору через сквер, от рядов
# через центральный сквер к площади и от площади к углу Ленина и Климова.
WALK_AREAS = {
    "сквер у собора": [
        (54.077769, 61.555903), (54.078152, 61.557325), (54.077839, 61.557859),
        (54.077386, 61.557681), (54.077178, 61.556140),
    ],
    "центральный сквер": [
        (54.083036, 61.558724), (54.083279, 61.559839), (54.081526, 61.561357),
        (54.081248, 61.560527), (54.082465, 61.558985),
    ],
}


# Дорожки, проложенные вручную по маршруту, нарисованному на месте: в OpenStreetMap
# этих дорожек скверов нет. Концы подключаются к ближайшим улицам и дорожкам.
MANUAL_PATHS = {
    # По карте 2ГИС: от камня по дорожке сквера к собору и к Красногвардейской.
    "от камня к собору и на Красногвардейскую": [
        (54.077456, 61.556294), (54.077776, 61.557391), (54.077955, 61.557250),
    ],
    "от верблюда к торговым рядам": [
        (54.081616, 61.561143), (54.081929, 61.560859), (54.081832, 61.560562),
    ],
    "от рядов через сквер к площади": [
        (54.081832, 61.560562), (54.081985, 61.560396), (54.082375, 61.560017), (54.082807, 61.559144),
    ],
    # От Компаса прямо вверх к краю площади у Ленина и вдоль него до Климова (дальше — по улицам).
    "от площади к Ленина и Климова": [
        (54.082807, 61.559144), (54.082982, 61.558902), (54.083226, 61.559715),
    ],
}
# Участки, которые должны идти через заданные точки (названия точек маршрута → точки по пути).
# От собора к верблюду — по Красногвардейской до улицы ВЛКСМ и по ней на север, как на месте.
LEG_VIA = {
    ("Свято-Троицкий собор", "Бронзовый верблюд"): [(54.078532, 61.559216)],
}

# Конец ручной дорожки ближе MANUAL_MERGE_M к узлу сети совпадает с этим узлом (без «хвостиков»
# на перекрёстке), ближе MANUAL_LINK_M — соединяется с ним коротким отрезком.
MANUAL_MERGE_M = 15.0
MANUAL_LINK_M = 40.0

# --- Геометрия ---------------------------------------------------------------------------


def dist(a, b):
    """Расстояние между (lat, lon), м."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH * math.asin(math.sqrt(min(1.0, h)))


def project(p, a, b):
    """Ближайшая к p точка отрезка ab: (t в 0..1, расстояние, м)."""
    kx = 111_320.0 * math.cos(math.radians(a[0]))
    ky = 111_320.0
    bx, by = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
    px, py = (p[1] - a[1]) * kx, (p[0] - a[0]) * ky
    l2 = bx * bx + by * by
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / l2))
    return t, math.hypot(px - t * bx, py - t * by)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def inside(p, ring):
    """Точка (lat, lon) внутри многоугольника [(lat, lon), ...]."""
    y, x = p
    hit = False
    for i in range(len(ring)):
        y1, x1 = ring[i - 1]
        y2, x2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


# --- OpenStreetMap -----------------------------------------------------------------------


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in OVERPASS:
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=300) as response:
                    return json.load(response)
            except (OSError, ValueError) as error:
                last = error
                print(f"  {url}: {error}, повтор")
                time.sleep(5 * (attempt + 1))
    raise SystemExit(f"Overpass недоступен: {last}")


def walk_factor(tags, in_open_space):
    """Во сколько раз путь по дороге «дороже» его длины; None — по ней не ходим."""
    hw = tags.get("highway")
    foot = tags.get("foot")
    if foot == "no" or tags.get("area") == "yes" and hw != "pedestrian":
        return None
    if tags.get("access") in ("private", "no") and foot not in ("yes", "designated", "permissive"):
        return None
    factor = base_factor(tags, hw, foot, in_open_space)
    if factor is not None and tags.get("surface") in UNPAVED:
        factor *= UNPAVED_FACTOR
    return factor


def base_factor(tags, hw, foot, in_open_space):
    if hw in MAIN_ROADS or hw == "pedestrian":
        return 1.0
    if hw in MINOR_ROADS:
        sidewalk = tags.get("sidewalk") in ("both", "left", "right", "yes", "separate") or any(
            tags.get(f"sidewalk:{side}") in ("yes", "separate") for side in ("both", "left", "right"))
        return min(SIDEWALK_ROAD, MINOR_ROADS[hw]) if sidewalk else MINOR_ROADS[hw]
    if hw == "footway":
        if tags.get("footway") in ("sidewalk", "crossing") or tags.get("name"):
            return 1.0
        # Безымянная дорожка — это либо сквер, либо двор. В скверах ходим, во дворы — нет.
        return 1.1 if in_open_space else None
    if hw == "steps":
        return 1.5 if in_open_space or tags.get("name") else None
    if hw in ("path", "cycleway") and in_open_space and foot in (None, "yes", "designated"):
        return 1.2
    # service (проезды во дворы, парковки), track, path вне скверов и прочее — не для прогулки.
    return None


def load_streets(south, west, north, east):
    bbox = f"{south},{west},{north},{east}"
    ways = overpass(f'[out:json][timeout:240][maxsize:536870912];way["highway"]({bbox});(._;>;);out body;')
    areas = overpass(
        f"[out:json][timeout:240];("
        f'way["leisure"~"^(park|garden)$"]({bbox});way["place"="square"]({bbox});'
        f'way["landuse"="recreation_ground"]({bbox});way["highway"="pedestrian"]["area"="yes"]({bbox});'
        f'relation["leisure"~"^(park|garden)$"]({bbox});relation["place"="square"]({bbox});'
        f");out geom;"
    )
    rings = []
    for el in areas["elements"]:
        if el["type"] == "way" and el.get("geometry"):
            rings.append([(g["lat"], g["lon"]) for g in el["geometry"]])
        elif el["type"] == "relation":
            outer = [(g["lat"], g["lon"]) for m in el.get("members", []) if m.get("role") == "outer"
                     for g in m.get("geometry", [])]
            if len(outer) >= 3:
                rings.append(outer)
    rings += WALK_AREAS.values()
    print(f"скверов и площадей: {len(rings)} (из них вручную: {len(WALK_AREAS)})")

    nodes = {el["id"]: (el["lat"], el["lon"]) for el in ways["elements"] if el["type"] == "node"}
    kept, dropped = [], []
    for el in ways["elements"]:
        if el["type"] != "way":
            continue
        pts = [nodes[n] for n in el["nodes"] if n in nodes]
        if len(pts) < 2:
            continue
        mid = pts[len(pts) // 2]
        factor = walk_factor(el.get("tags", {}), any(inside(mid, r) for r in rings))
        (kept if factor else dropped).append((el["nodes"], factor, pts))
    print(f"дорог и дорожек: {len(kept)} берём, {len(dropped)} отброшено")
    return nodes, kept, dropped


# --- Граф и поиск пути -------------------------------------------------------------------


class Graph:
    def __init__(self, coords, edges):
        self.coords = coords  # [(lat, lon)]
        self.edges = edges  # [(a, b, factor)]
        self.adj = [[] for _ in coords]
        for i, (a, b, f) in enumerate(edges):
            length = dist(coords[a], coords[b])
            self.adj[a].append((b, length * f))
            self.adj[b].append((a, length * f))

    @staticmethod
    def build(nodes, kept, manual=()):
        index, coords, edges = {}, [], []

        def node(osm_id):
            if osm_id not in index:
                index[osm_id] = len(coords)
                coords.append(nodes[osm_id])
            return index[osm_id]

        seen = set()
        for osm_nodes, factor, _ in kept:
            ids = [n for n in osm_nodes if n in nodes]
            for u, v in zip(ids, ids[1:]):
                if u == v:
                    continue
                a, b = node(u), node(v)
                key = (min(a, b), max(a, b))
                if key in seen:
                    continue
                seen.add(key)
                edges.append((a, b, factor))
        osm_count = len(coords)
        # Ручные дорожки: свои узлы, концы и совпадающие точки соединяются.
        manual_nodes = {}
        for line in manual:
            ids = []
            for k, pt in enumerate(line):
                key = (round(pt[0], 6), round(pt[1], 6))
                if key not in manual_nodes:
                    near = min(range(osm_count), key=lambda n: dist(coords[n], pt)) if osm_count else None
                    if k in (0, len(line) - 1) and near is not None and dist(coords[near], pt) <= MANUAL_MERGE_M:
                        manual_nodes[key] = near
                    else:
                        manual_nodes[key] = len(coords)
                        coords.append(pt)
                ids.append(manual_nodes[key])
            for a, b in zip(ids, ids[1:]):
                if a != b:
                    edges.append((a, b, 1.0))
            for end in (ids[0], ids[-1]):
                if end < osm_count:
                    continue
                near = min(range(osm_count), key=lambda n: dist(coords[n], coords[end]))
                if dist(coords[near], coords[end]) <= MANUAL_LINK_M:
                    edges.append((end, near, 1.0))
        graph = Graph(coords, edges)
        return graph.largest_component()

    def largest_component(self):
        """Только самая большая связная часть: из неё до любой точки можно дойти."""
        comp = [-1] * len(self.coords)
        sizes = []
        for start in range(len(self.coords)):
            if comp[start] != -1:
                continue
            c, stack, size = len(sizes), [start], 0
            comp[start] = c
            while stack:
                u = stack.pop()
                size += 1
                for v, _ in self.adj[u]:
                    if comp[v] == -1:
                        comp[v] = c
                        stack.append(v)
            sizes.append(size)
        best = max(range(len(sizes)), key=sizes.__getitem__)
        remap, coords = {}, []
        for i, c in enumerate(comp):
            if c == best:
                remap[i] = len(coords)
                coords.append(self.coords[i])
        edges = [(remap[a], remap[b], f) for a, b, f in self.edges if comp[a] == best]
        print(f"граф: {len(coords)} узлов, {len(edges)} отрезков (отброшено {len(self.coords) - len(coords)} несвязанных узлов)")
        return Graph(coords, edges)

    def simplified(self, tolerance):
        """Тот же граф без лишних узлов на изгибах: перекрёстки и смена «цены» сохраняются,
        промежуточные точки улицы — только там, где без них линия ушла бы больше tolerance метров."""
        edge_of = {}
        for a, b, f in self.edges:
            edge_of[(a, b)] = edge_of[(b, a)] = f
        nbrs = [[] for _ in self.coords]
        for a, b, _ in self.edges:
            nbrs[a].append(b)
            nbrs[b].append(a)

        def joint(n):
            return len(nbrs[n]) != 2 or edge_of[(n, nbrs[n][0])] != edge_of[(n, nbrs[n][1])]

        done, out = set(), []

        def walk(start, nxt):
            chain = [start, nxt]
            done.add((min(start, nxt), max(start, nxt)))
            while not joint(chain[-1]) and chain[-1] != start:
                u, v = chain[-2], chain[-1]
                w = nbrs[v][0] if nbrs[v][0] != u else nbrs[v][1]
                done.add((min(v, w), max(v, w)))
                chain.append(w)
            keep = rdp(chain, self.coords, tolerance)
            f = edge_of[(chain[0], chain[1])]
            out.extend((a, b, f) for a, b in zip(keep, keep[1:]) if a != b)

        for n in range(len(self.coords)):
            if joint(n):
                for m in nbrs[n]:
                    if (min(n, m), max(n, m)) not in done:
                        walk(n, m)
        for a, b, _ in self.edges:  # кольца без перекрёстков
            if (min(a, b), max(a, b)) not in done:
                walk(a, b)
        used = sorted({n for a, b, _ in out for n in (a, b)})
        remap = {n: i for i, n in enumerate(used)}
        return Graph([self.coords[n] for n in used], [(remap[a], remap[b], f) for a, b, f in out])

    def snap(self, p):
        """Ближайшая точка сети дорожек: (ребро, t, точка, расстояние)."""
        best = None
        for i, (a, b, _) in enumerate(self.edges):
            t, d = project(p, self.coords[a], self.coords[b])
            if best is None or d < best[3]:
                best = (i, t, lerp(self.coords[a], self.coords[b], t), d)
        return best

    def route(self, p, q):
        """Путь по сети от p до q: список (lat, lon), начинается в p и кончается в q."""
        es, ts, sp, _ = self.snap(p)
        et, tt, tp, _ = self.snap(q)
        a, b, f = self.edges[es]
        c, d, g = self.edges[et]
        if es == et:
            line = [sp, tp]
        else:
            la = dist(self.coords[a], self.coords[b]) * f
            lc = dist(self.coords[c], self.coords[d]) * g
            costs = {c: tt * lc, d: (1 - tt) * lc}
            best = [math.inf] * len(self.coords)
            prev = [-1] * len(self.coords)
            heap = []
            for n, cost in ((a, ts * la), (b, (1 - ts) * la)):
                if cost < best[n]:
                    best[n] = cost
                    heapq.heappush(heap, (cost, n))
            while heap:
                cost, u = heapq.heappop(heap)
                if cost > best[u]:
                    continue
                for v, w in self.adj[u]:
                    if cost + w < best[v]:
                        best[v] = cost + w
                        prev[v] = u
                        heapq.heappush(heap, (cost + w, v))
            end = min(costs, key=lambda n: best[n] + costs[n])
            chain = []
            n = end
            while n != -1:
                chain.append(self.coords[n])
                n = prev[n]
            line = [sp] + chain[::-1] + [tp]
        out = [p]
        for pt in line + [q]:
            if dist(out[-1], pt) > 0.5:
                out.append(pt)
        return despike(out)


def rdp(chain, coords, tolerance):
    """Рамер — Дуглас — Пекер: узлы цепочки, без которых линия отходит больше чем на tolerance м."""
    if len(chain) < 3:
        return list(chain)
    a, b = coords[chain[0]], coords[chain[-1]]
    worst, at = 0.0, 0
    for k in range(1, len(chain) - 1):
        d = project(coords[chain[k]], a, b)[1]
        if d > worst:
            worst, at = d, k
    if worst <= tolerance:
        return [chain[0], chain[-1]]
    return rdp(chain[:at + 1], coords, tolerance)[:-1] + rdp(chain[at:], coords, tolerance)


def despike(points):
    """Убирает «хвостики»: короткий заход в сторону и возврат по той же линии."""
    pts = list(points)
    changed = True
    while changed and len(pts) > 2:
        changed = False
        for i in range(1, len(pts) - 1):
            a, b, c = pts[i - 1], pts[i], pts[i + 1]
            there, back = dist(a, b), dist(b, c)
            if min(there, back) < 25 and dist(a, c) < 0.3 * (there + back):
                del pts[i]
                changed = True
                break
    return pts


def leg_route(graph, stops, titles, i, j):
    """Путь от точки i к точке j, через заданные для этой пары точки (LEG_VIA)."""
    via = LEG_VIA.get((titles[i], titles[j]))
    if via is None and (titles[j], titles[i]) in LEG_VIA:
        via = LEG_VIA[(titles[j], titles[i])][::-1]
    points = [stops[i]] + list(via or []) + [stops[j]]
    out = graph.route(points[0], points[1])
    for a, b in zip(points[1:], points[2:]):
        out += graph.route(a, b)[1:]
    return despike(out)


def length(points):
    return sum(dist(points[i - 1], points[i]) for i in range(1, len(points)))


# --- Картинка-проверка -------------------------------------------------------------------


def render(kept, dropped, stops, titles, order, legs, radii):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Circle

    lat0 = sum(s[0] for s in stops) / len(stops)
    kx = math.cos(math.radians(lat0))
    s_, n_ = min(p[0] for p in stops) - 0.004, max(p[0] for p in stops) + 0.004
    w_, e_ = min(p[1] for p in stops) - 0.007, max(p[1] for p in stops) + 0.007
    near = lambda pts: any(s_ <= p[0] <= n_ and w_ <= p[1] <= e_ for p in pts)  # noqa: E731
    kept = [k for k in kept if near(k[2])]
    dropped = [d for d in dropped if near(d[2])]
    fig, ax = plt.subplots(figsize=(14, 18), dpi=150)
    ax.set_facecolor("#f6f1e7")
    for _, _, pts in dropped:
        ax.plot([p[1] * kx for p in pts], [p[0] for p in pts], color="#e8a0a0", lw=0.8, ls=(0, (2, 2)), zorder=1)
    for ring in WALK_AREAS.values():
        ax.fill([p[1] * kx for p in ring], [p[0] for p in ring], color="#7cc84a", alpha=0.25, zorder=0)
    for _, factor, pts in kept:
        # Чем «дешевле» улица, тем темнее и толще: по таким путь и выбирается.
        color, lw = ("#5f5f5f", 1.9) if factor <= 1.05 else ("#9a9a9a", 1.4) if factor <= 1.25 else ("#cdbfae", 1.1)
        ax.plot([p[1] * kx for p in pts], [p[0] for p in pts], color=color, lw=lw, zorder=2)
    for pts in MANUAL_PATHS.values():
        ax.plot([p[1] * kx for p in pts], [p[0] for p in pts], color="#2e9e4f", lw=2.2, zorder=2)
    for k, (i, j) in enumerate(zip(order, order[1:])):
        pts = legs[(i, j)]
        xs, ys = [p[1] * kx for p in pts], [p[0] for p in pts]
        ax.plot(xs, ys, color="white", lw=7, solid_capstyle="round", zorder=3)
        ax.plot(xs, ys, color="#d2463c", lw=4, solid_capstyle="round", zorder=4)
        m = len(pts) // 2
        ax.annotate("", xy=(xs[m], ys[m]), xytext=(xs[m - 1], ys[m - 1]),
                    arrowprops=dict(arrowstyle="-|>", color="#8a1f18", lw=2), zorder=5)
    for n, i in enumerate(order, start=1):
        lat, lon = stops[i]
        r = radii[i] / 111_320.0
        ax.add_patch(Circle((lon * kx, lat), r, color="#2f6fb5", alpha=0.18, zorder=6))
        ax.plot(lon * kx, lat, "o", ms=16, color="#2f6fb5", mec="white", mew=2, zorder=7)
        ax.text(lon * kx, lat, str(n), ha="center", va="center", color="white", fontsize=10, weight="bold", zorder=8)
        ax.text(lon * kx + 0.00012, lat + 0.00008, f"{n}. {titles[i]} · {radii[i]:.0f} м", fontsize=9, zorder=8,
                bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="none", alpha=0.85))
    lats = [s[0] for s in stops]
    lons = [s[1] * kx for s in stops]
    ax.set_xlim(min(lons) - 0.0035, max(lons) + 0.0035)
    ax.set_ylim(min(lats) - 0.002, max(lats) + 0.002)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    total = sum(length(legs[(i, j)]) for i, j in zip(order, order[1:]))
    ax.set_title(f"«Весь маршрут»: {total:.0f} м. Тёмное — главные улицы и тротуары, серое — жилые с тротуаром,\n"
                 f"бежевое — переулки и грунтовки (путь по ним «дороже»); розовый пунктир — отброшенные дворы и тропинки;\n"
                 f"зелёное — скверы и дорожки, проложенные вручную; круги — радиус прибытия", fontsize=12)
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(PREVIEW)
    print(f"картинка: {PREVIEW.relative_to(REPO)}")


# --- Главное -----------------------------------------------------------------------------


def main():
    route = json.loads(ROUTE.read_text(encoding="utf-8"))
    stops = [(s["lat"], s["lon"]) for s in route["stops"]]
    titles = [s["title"] for s in route["stops"]]
    radii = [s.get("radius", 20) for s in route["stops"]]

    lat0 = (min(p[0] for p in stops) + max(p[0] for p in stops)) / 2
    lon0 = (min(p[1] for p in stops) + max(p[1] for p in stops)) / 2
    dlat = AREA_KM / 2 / 111.32
    dlon = dlat / math.cos(math.radians(lat0))
    nodes, kept, dropped = load_streets(lat0 - dlat, lon0 - dlon, lat0 + dlat, lon0 + dlon)
    graph = Graph.build(nodes, kept, MANUAL_PATHS.values())

    for i, p in enumerate(stops):
        _, _, point, d = graph.snap(p)
        print(f"точка {i + 1} «{titles[i]}»: до улицы {d:.0f} м ({point[0]:.6f}, {point[1]:.6f})")

    legs, out_legs = {}, []
    for i in range(len(stops)):
        for j in range(i + 1, len(stops)):
            pts = leg_route(graph, stops, titles, i, j)
            meters, straight = length(pts), dist(stops[i], stops[j])
            print(f"{i + 1} → {j + 1}: {meters:.0f} м пешком, {straight:.0f} м по прямой")
            if meters > straight * 4 + 200:
                raise SystemExit(f"{i + 1} → {j + 1} подозрительно длинный: {meters:.0f} м")
            legs[(i, j)] = pts
            legs[(j, i)] = pts[::-1]
            out_legs.append({"from": i, "to": j, "meters": round(meters),
                             "points": [[round(p[1], 6), round(p[0], 6)] for p in pts]})

    PATHS.write_text(json.dumps({
        "route": route["id"],
        "source": "улицы и тротуары без дворов; данные © участники OpenStreetMap (ODbL)",
        "legs": out_legs,
    }, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    small = graph.simplified(SIMPLIFY_M)
    print(f"для телефона: {len(small.coords)} узлов, {len(small.edges)} отрезков")
    STREETS.write_text(json.dumps({
        "source": "© участники OpenStreetMap (ODbL)",
        # Узлы подряд: широта, долгота; отрезки подряд: узел, узел, «цена» ×100.
        "nodes": [round(v, 5) for c in small.coords for v in c],
        "edges": [v for a, b, f in small.edges for v in (a, b, round(f * 100))],
    }, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"записано: {PATHS.relative_to(REPO)}, {STREETS.relative_to(REPO)} ({STREETS.stat().st_size // 1024} КБ)")

    order = route.get("default_order", list(range(len(stops))))
    render(kept, dropped, stops, titles, order, legs, radii)


if __name__ == "__main__":
    main()
