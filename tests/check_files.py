#!/usr/bin/env python3
"""Быстрая проверка перед выкладкой: данные читаются, а всё, что sw.js сохраняет в телефон,
и всё, на что ссылаются маршрут и сайт, на месте.

    python3 tests/check_files.py
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
errors = []


def need(path, why):
    if not (ROOT / path).is_file():
        errors.append(f"нет файла {path} ({why})")


for name in ("route", "paths", "streets", "files", "reviews"):
    try:
        json.loads((ROOT / f"data/{name}.json").read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        errors.append(f"data/{name}.json не читается: {e}")

sw = (ROOT / "progulka/sw.js").read_text(encoding="utf-8")
shell = re.search(r"const SHELL = \[(.*?)\];", sw, re.S).group(1)
for f in re.findall(r"'([^']+)'", shell):
    if f != "./":
        need(os.path.normpath(os.path.join("progulka", f)), "SHELL в progulka/sw.js")

for f in json.loads((ROOT / "data/files.json").read_text(encoding="utf-8")):
    need(f, "data/files.json")

route = json.loads((ROOT / "data/route.json").read_text(encoding="utf-8"))
need(f"stickers/{route['badge']}.webp", "значок маршрута")
for n, stop in enumerate(route["stops"], start=1):
    need(f"stickers/{stop['sticker']}.webp", f"наклейка точки {n}")
    for clip in ("narrator", "trosha", "task", "parent"):
        need(f"audio/stop{n}_{clip}.mp3", f"озвучка точки {n}")
    for key in ("lat", "lon", "parent_story"):
        if key not in stop:
            errors.append(f"у точки {n} нет поля {key}")
try:
    style = json.loads((ROOT / "map/style.json").read_text(encoding="utf-8"))
    need("map/" + style["sprite"] + ".json", "значки карты")
    for src in style["sources"].values():
        z = src["minzoom"]
        if not any((ROOT / "map" / src["tiles"][0].split("{z}")[0] / str(z)).iterdir()):
            errors.append(f"нет кусочков карты на приближении {z}")
except Exception as e:  # noqa: BLE001
    errors.append(f"map/style.json не читается — запустите workflow «Map»: {e}")
paths = json.loads((ROOT / "data/paths.json").read_text(encoding="utf-8"))
if paths.get("route") != route["id"]:
    errors.append("data/paths.json построен для другого маршрута")

site = (ROOT / "index.html").read_text(encoding="utf-8")
for ref in re.findall(r'(?:src|href)="([^"#:]+)"', site):
    if "'" in ref or "+" in ref:  # адрес, который собирает скрипт страницы
        continue
    target = os.path.normpath(ref)
    need(os.path.join(target, "index.html") if ref.endswith("/") else target, f"ссылка {ref} на сайте проекта")
flips = len(re.findall(r'class="flip ', site))
for n in range(1, flips + 1):
    need(f"site/audio/fact{n}.mp3", "озвучка карточки на сайте")

# Для поисковиков: карта сайта ведёт на настоящие страницы, а точки в разметке schema.org
# на главной совпадают с маршрутом (после правки точек обновите их в index.html).
for loc in re.findall(r"<loc>https://[^/]+/([^<]*)</loc>", (ROOT / "sitemap.xml").read_text(encoding="utf-8")):
    need(loc + "index.html" if loc.endswith("/") or not loc else loc, "sitemap.xml")
ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', site, re.S).group(1))
trip = next(g for g in ld["@graph"] if g["@type"] == "TouristTrip")
names = [i["item"]["name"] for i in trip["itinerary"]["itemListElement"]]
if names != [route["stops"][i]["title"] for i in route["default_order"]]:
    errors.append("точки в разметке schema.org на главной (index.html) не совпадают с data/route.json")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"Файлы в порядке: {len(route['stops'])} точек, {flips} карточек на сайте.")
