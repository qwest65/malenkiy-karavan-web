#!/usr/bin/env python3
"""Собирает статичный сайт из data/site.json: index.html, privacy.html, 404.html, sitemap.xml, robots.txt.

Весь контент (название, тексты, карточки, вопросы, контакты) лежит в data/site.json, вёрстка — в этом
скрипте и assets/style.css. Менять сайт: правите data/site.json, запускаете

    python3 tools/build_site.py

и коммитите получившиеся файлы (сервер отдаёт готовый HTML, ничего собирать на нём не надо).
Проверка перед выкладкой, tests/check_site.py, следит, чтобы собранные файлы не отставали от данных.

Типы разделов (sections[].type): text (абзацы), cards (карточки с картинкой), faq (вопросы и ответы,
с разметкой FAQPage для поисковиков), contacts (подпись, значение, необязательная ссылка).
Пока "draft": true, сайт закрыт от поисковиков (noindex и Disallow: /); перед запуском поставьте false.
"""
import hashlib
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_FILES = ("index.html", "privacy.html", "404.html", "sitemap.xml", "robots.txt")


def esc(s):
    return html.escape(str(s), quote=True)


def ver(path):
    """Короткая метка содержимого файла: ссылка на стили и скрипты меняется вместе с ними, кэш браузера не мешает."""
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()[:8]


def load():
    return json.loads((ROOT / "data/site.json").read_text(encoding="utf-8"))


def json_ld(obj):
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def head(d, title, desc, canonical, robots, extra=""):
    s = d["site"]
    ogimg = s["url"].rstrip("/") + "/" + s["og_image"]
    v = ver("assets/style.css")
    ver_f = ver("fonts/rubik.css")
    verify = f'\n  <meta name="yandex-verification" content="{esc(s["yandex_verification"])}">' if s.get("yandex_verification") else ""
    return f"""<!doctype html>
<html lang="{esc(s["lang"])}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="{esc(s["theme_color"])}">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}">
  <link rel="canonical" href="{esc(canonical)}">
  <meta name="robots" content="{robots}">{verify}
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="{esc(s["name"])}">
  <meta property="og:locale" content="ru_RU">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(desc)}">
  <meta property="og:url" content="{esc(canonical)}">
  <meta property="og:image" content="{esc(ogimg)}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="{esc(s["icon"])}">
  <link rel="stylesheet" href="fonts/rubik.css?v={ver_f}">
  <link rel="stylesheet" href="assets/style.css?v={v}">{extra}
</head>
"""


def colors_css(d):
    c = d["colors"]
    return ("<style>:root{" + ";".join(f"--{k.replace('_', '-')}:{esc(v)}" for k, v in c.items()) + "}</style>")


def section(sec):
    t, sid, title = sec["type"], esc(sec["id"]), esc(sec["title"])
    out = [f'  <section id="{sid}">\n    <div class="panel">\n      <h2>{title}</h2>']
    if sec.get("lead"):
        out.append(f'      <p class="lead">{esc(sec["lead"])}</p>')
    if t == "text":
        out += [f"      <p>{esc(p)}</p>" for p in sec["paragraphs"]]
    elif t == "cards":
        out.append('      <div class="cards">')
        for it in sec["items"]:
            img = f'<img loading="lazy" decoding="async" src="{esc(it["image"])}" alt="{esc(it.get("alt", ""))}">' if it.get("image") else ""
            out.append(f'        <article class="card">{img}<h3>{esc(it["title"])}</h3><p>{esc(it["text"])}</p></article>')
        out.append("      </div>")
    elif t == "faq":
        for it in sec["items"]:
            out.append(f'      <details class="faq"><summary>{esc(it["q"])}</summary><p>{esc(it["a"])}</p></details>')
    elif t == "contacts":
        out.append('      <dl class="contacts">')
        for it in sec["items"]:
            val = esc(it["value"])
            if it.get("href"):
                val = f'<a href="{esc(it["href"])}">{val}</a>'
            out.append(f'        <dt>{esc(it["label"])}</dt><dd>{val}</dd>')
        out.append("      </dl>")
    else:
        raise SystemExit(f"неизвестный тип раздела: {t}")
    out.append("    </div>\n  </section>")
    return "\n".join(out)


def build():
    d = load()
    s = d["site"]
    base = s["url"].rstrip("/")
    draft = bool(d.get("draft", True))
    robots = "noindex, nofollow" if draft else "index, follow"
    title = f'{s["name"]} — {s["tagline"]}'
    ld = [{"@context": "https://schema.org", "@type": "WebSite", "name": s["name"], "url": base + "/", "description": s["description"]}]
    faq = [it for sec in d["sections"] if sec["type"] == "faq" for it in sec["items"]]
    if faq:
        ld.append({"@context": "https://schema.org", "@type": "FAQPage",
                   "mainEntity": [{"@type": "Question", "name": q["q"], "acceptedAnswer": {"@type": "Answer", "text": q["a"]}} for q in faq]})
    ld_html = "".join(f'\n  <script type="application/ld+json">{json_ld(x)}</script>' for x in ld)

    nav = "".join(f'<a href="#{esc(sec["id"])}">{esc(sec["title"])}</a>' for sec in d["sections"])
    cta = f'<a class="cta" href="{esc(s["cta"]["href"])}">{esc(s["cta"]["label"])}</a>' if s.get("cta") else ""
    body = f"""<body>
<header class="hero" id="top">
  <div class="wrap">
    <nav class="nav" aria-label="Разделы">{nav}</nav>
    <h1>{esc(s["name"])}</h1>
    <p class="tagline">{esc(s["tagline"])}</p>
    {cta}
  </div>
</header>
<main class="wrap">
{chr(10).join(section(x) for x in d["sections"])}
</main>
<footer class="foot"><div class="wrap">© {esc(s["name"])} · <a href="privacy.html">{esc(d["privacy"]["title"])}</a></div></footer>
</body>
</html>
"""
    index = head(d, title, s["description"], base + "/", robots, colors_css(d) + ld_html) + body

    p = d["privacy"]
    priv = head(d, f'{p["title"]} — {s["name"]}', p["title"], base + "/privacy.html", "noindex, follow", colors_css(d)) + f"""<body>
<main class="wrap narrow">
  <div class="panel">
    <h1>{esc(p["title"])}</h1>
{chr(10).join("    <p>" + esc(x) + "</p>" for x in p["paragraphs"])}
    <p><a href="./">← На главную</a></p>
  </div>
</main>
</body>
</html>
"""
    nf = head(d, f'Страница не найдена — {s["name"]}', "Такой страницы нет.", base + "/404.html", "noindex, follow", colors_css(d)) + """<body>
<main class="wrap narrow">
  <div class="panel">
    <h1>Такой страницы нет</h1>
    <p>Возможно, ссылка устарела или в ней опечатка.</p>
    <p><a href="/">← На главную</a></p>
  </div>
</main>
</body>
</html>
"""
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
               f'  <url><loc>{esc(base)}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n</urlset>\n')
    if draft:
        robots_txt = "# Сайт в черновике: поисковикам закрыт. Перед запуском в data/site.json поставьте \"draft\": false.\nUser-agent: *\nDisallow: /\n"
    else:
        robots_txt = f"User-agent: *\nAllow: /\n\nSitemap: {base}/sitemap.xml\n"
    return {"index.html": index, "privacy.html": priv, "404.html": nf, "sitemap.xml": sitemap, "robots.txt": robots_txt}


def main():
    for name, text in build().items():
        (ROOT / name).write_text(text, encoding="utf-8")
    print("собрано:", ", ".join(OUT_FILES))


if __name__ == "__main__":
    sys.exit(main())
