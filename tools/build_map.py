#!/usr/bin/env python3
"""Своя подложка карты: всё, что нужно карте вокруг Троицка, лежит в папке map/ рядом с прогулкой.

Чужой сервер карт у части провайдеров заблокирован: маршрут на карте виден, а улиц под ним нет.
Поэтому один раз скачиваем с OpenFreeMap (данные OpenStreetMap) всё для района прогулки
и кладём к себе:

- map/style.json        — оформление карты (стиль Liberty) со ссылками на файлы ниже
                          (адреса — относительно папки map/);
- map/tiles/z/x/y.pbf   — кусочки карты на приближениях 11–14 (ближе карта дорисовывает их сама);
- map/sprites/          — значки;
- map/fonts/            — шрифты подписей с кириллицей.

Прогулка открывается — открывается и карта: всё с одного адреса, и sw.js сохраняет это в телефон
вместе с остальными файлами (data/files.json).

    python3 tools/build_map.py

Запускается в GitHub Actions (.github/workflows/map.yml). Карта сама не обновляется:
когда в городе что-то поменялось, запустите workflow «Map» вручную.
"""
import gzip
import json
import math
import pathlib
import shutil
import sys
import time
import urllib.parse
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
from update_files import update_files  # noqa: E402

ROUTE = REPO / "data/route.json"
OUT = REPO / "map"
STYLE_URL = "https://tiles.openfreemap.org/styles/liberty"
USER_AGENT = "MalenkiyKaravan-build/1.0 (+https://github.com/qwest65/malenkiy-karavan-web)"

MIN_ZOOM = 11
MAX_ZOOM = 14
# Запас вокруг точек маршрута, градусы (~4 км): весь город, чтобы дойти до прогулки из дома.
MARGIN = 0.04
GLYPH_RANGES = ["0-255", "256-511", "1024-1279", "8192-8447"]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or data[:2] == b"\x1f\x8b":
                    data = gzip.decompress(data)
                return data
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            print(f"  повтор {url}: {e}")
            time.sleep(2 ** attempt)


def get_json(url):
    return json.loads(get(url))


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def tile_range(bbox, z):
    west, south, east, north = bbox
    n = 2 ** z
    x = lambda lon: int((lon + 180) / 360 * n)  # noqa: E731
    y = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)  # noqa: E731
    for tx in range(x(west), x(east) + 1):
        for ty in range(y(north), y(south) + 1):
            yield tx, ty


def build():
    stops = json.loads(ROUTE.read_text(encoding="utf-8"))["stops"]
    lats = [s["lat"] for s in stops]
    lons = [s["lon"] for s in stops]
    bbox = [min(lons) - MARGIN, min(lats) - MARGIN, max(lons) + MARGIN, max(lats) + MARGIN]

    style = get_json(STYLE_URL)
    if OUT.exists():
        shutil.rmtree(OUT)

    # Только векторная карта: растровый рельеф мира виден лишь при сильном отдалении.
    sources = {}
    for name, src in style["sources"].items():
        if src.get("type") != "vector":
            continue
        tj = get_json(src["url"]) if "url" in src else src
        template = tj["tiles"][0]
        count = 0
        for z in range(MIN_ZOOM, MAX_ZOOM + 1):
            for tx, ty in tile_range(bbox, z):
                url = template.replace("{z}", str(z)).replace("{x}", str(tx)).replace("{y}", str(ty))
                save(OUT / f"tiles/{name}/{z}/{tx}/{ty}.pbf", get(url))
                count += 1
        print(f"{name}: {count} кусочков карты")
        sources[name] = {
            "type": "vector",
            "tiles": [f"tiles/{name}/{{z}}/{{x}}/{{y}}.pbf"],
            "minzoom": MIN_ZOOM,
            "maxzoom": MAX_ZOOM,
            "bounds": [round(v, 5) for v in bbox],
            "attribution": tj.get("attribution", "© OpenStreetMap"),
        }
    style["sources"] = sources
    style["layers"] = [l for l in style["layers"] if l["type"] == "background" or l.get("source") in sources]

    sprite = style.get("sprite")
    if isinstance(sprite, str):
        for k in ["", "@2x"]:
            for ext in [".json", ".png"]:
                save(OUT / f"sprites/sprite{k}{ext}", get(sprite + k + ext))
        style["sprite"] = "sprites/sprite"

    stacks = set()
    for layer in style["layers"]:
        font = layer.get("layout", {}).get("text-font")
        if isinstance(font, list) and all(isinstance(f, str) for f in font):
            stacks.add(",".join(font))
    glyphs = style["glyphs"]
    for stack in sorted(stacks):
        for rng in GLYPH_RANGES:
            url = glyphs.replace("{fontstack}", urllib.parse.quote(stack)).replace("{range}", rng)
            save(OUT / f"fonts/{stack}/{rng}.pbf", get(url))
    style["glyphs"] = "fonts/{fontstack}/{range}.pbf"
    print(f"шрифты: {', '.join(sorted(stacks))}")

    save(OUT / "style.json", json.dumps(style, ensure_ascii=False, separators=(",", ":")).encode())
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"map/: {size / 1e6:.1f} МБ")
    update_files()


if __name__ == "__main__":
    build()
