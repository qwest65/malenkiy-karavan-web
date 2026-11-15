#!/usr/bin/env python3
"""Проверка перед выкладкой статичного сайта (без браузера и без сети, работает за секунды):

  * data/site.json читается, у разделов известные типы и уникальные id, у картинок есть файл и описание (alt);
  * собранные страницы (index.html, privacy.html, 404.html, sitemap.xml, robots.txt) не отстают от data/site.json,
    иначе: python3 tools/build_site.py;
  * в HTML закрыты все теги, все локальные ссылки, картинки, стили и якоря (#раздел) ведут на существующее;
  * пока "draft": true, сайт закрыт от поисковиков; когда "draft": false, в данных не должно остаться заглушек.

    python3 tests/check_site.py
"""
import importlib.util
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
errors = []

spec = importlib.util.spec_from_file_location("build_site", ROOT / "tools/build_site.py")
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)

try:
    d = bs.load()
except Exception as e:  # noqa: BLE001
    sys.exit(f"data/site.json не читается: {e}")

TYPES = {"text", "cards", "faq", "contacts"}
for key in ("name", "tagline", "description", "lang", "url", "theme_color", "og_image", "icon"):
    if not str(d.get("site", {}).get(key, "")).strip():
        errors.append(f"в data/site.json пусто поле site.{key}")
ids = [s.get("id") for s in d.get("sections", [])]
if len(ids) != len(set(ids)):
    errors.append("в data/site.json повторяются id разделов")
for s in d.get("sections", []):
    if s.get("type") not in TYPES:
        errors.append(f"раздел {s.get('id')}: неизвестный тип {s.get('type')} (бывают {', '.join(sorted(TYPES))})")
    for it in s.get("items", []):
        if it.get("image"):
            if not (ROOT / it["image"]).is_file():
                errors.append(f"раздел {s['id']}: нет файла картинки {it['image']}")
            if not it.get("alt", "").strip():
                errors.append(f"раздел {s['id']}: у картинки {it['image']} нет описания (alt)")
for f in (d["site"]["og_image"], d["site"]["icon"]):
    if not (ROOT / f).is_file():
        errors.append(f"нет файла {f}")
if len(d["site"]["description"]) > 300:
    errors.append("описание сайта длиннее 300 знаков: поисковики его обрежут")

# 1) собранные файлы не отстают от данных
built = bs.build()
for name, text in built.items():
    p = ROOT / name
    if not p.is_file() or p.read_text(encoding="utf-8") != text:
        errors.append(f"{name} устарел или не собран (python3 tools/build_site.py)")

# 2) разбор HTML: теги закрыты, ссылки и якоря живые
VOID = {"meta", "link", "img", "br", "hr", "input", "source", "area", "base", "col", "embed", "track", "wbr"}


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.ids, self.refs, self.frags, self.errs = [], set(), [], [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.ids.add(a["id"])
        for k in ("src", "href"):
            if a.get(k):
                (self.frags if a[k].startswith("#") else self.refs).append(a[k])
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack or self.stack[-1] != tag:
            self.errs.append(f"лишний или незакрытый тег </{tag}> (внутри <{self.stack[-1] if self.stack else '-'}>)")
        else:
            self.stack.pop()


for name in ("index.html", "privacy.html", "404.html"):
    pg = Page()
    pg.feed((ROOT / name).read_text(encoding="utf-8"))
    errors += [f"{name}: {e}" for e in pg.errs]
    if pg.stack:
        errors.append(f"{name}: не закрыты теги {pg.stack}")
    for ref in pg.refs:
        u = urlsplit(ref)
        if u.scheme in ("http", "https", "mailto", "tel") or ref.startswith("//"):
            continue
        path = u.path.lstrip("/") or "index.html"
        if path.endswith("/"):
            path += "index.html"
        if not (ROOT / path).is_file():
            errors.append(f"{name}: ссылка {ref} никуда не ведёт")
    for fr in pg.frags:
        if fr != "#" and fr[1:] not in pg.ids:
            errors.append(f"{name}: якорь {fr} не найден на странице")

# 3) черновик и заглушки
robots = built["robots.txt"]
if d.get("draft", True):
    if "Disallow: /" not in robots or "noindex" not in built["index.html"]:
        errors.append("пока draft=true сайт должен быть закрыт от поисковиков")
else:
    text = json.dumps(d, ensure_ascii=False)
    for marker in ("example.ru", "Название сайта", "Первая карточка", "Вторая карточка", "000 000", "Город, улица", "placeholder.svg", "Здесь будет"):
        if marker in text:
            errors.append(f"draft=false, но в данных осталась заглушка: «{marker}»")
    if "noindex" in built["index.html"].split("</head>")[0].split('name="robots"')[1].split(">")[0]:
        errors.append("draft=false, а главная закрыта от поисковиков")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"Сайт в порядке: {len(d['sections'])} разделов, черновик: {'да' if d.get('draft', True) else 'нет'}.")
