#!/usr/bin/env python3
"""Считает запуски прогулки: сколько раз открыли, начали, дошли до конца, поставили на экран «Домой».

Функция counter/index.js кладёт в бакет Object Storage по пустому файлу «день/событие/номер». Скрипт читает
публичный список файлов бакета, считает по дням и пишет:

    <папка>/STATS.md     — таблица за последние 30 дней и итоги (её видно на GitHub)
    <папка>/stats.json   — все дни, для программ

    python3 tools/count_stats.py <папка>

Имя бакета — в counter/bucket.txt (пусто — счётчик ещё не настроен). Запускается workflow Stats раз в сутки.
"""
import datetime
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENDPOINT = os.environ.get("STAT_ENDPOINT", "https://storage.yandexcloud.net")
EVENTS = ("open", "start", "finish", "install")
TITLES = {"open": "Открыли", "start": "Начали прогулку", "finish": "Дошли до конца", "install": "На экран «Домой»"}


def list_keys(bucket):
    token = None
    while True:
        params = {"list-type": "2", "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        with urllib.request.urlopen(f"{ENDPOINT}/{bucket}?{urllib.parse.urlencode(params)}", timeout=60) as r:
            tree = ET.fromstring(r.read())
        ns = {"s": tree.tag.split("}")[0][1:]} if tree.tag.startswith("{") else {}
        q = "s:" if ns else ""
        for c in tree.findall(f"{q}Contents", ns):
            yield c.find(f"{q}Key", ns).text
        if (tree.findtext(f"{q}IsTruncated", namespaces=ns) or "false") != "true":
            return
        token = tree.findtext(f"{q}NextContinuationToken", namespaces=ns)


def count(bucket):
    days = {}
    for key in list_keys(bucket):
        parts = key.split("/")
        if len(parts) == 3 and parts[1] in EVENTS:
            days.setdefault(parts[0], dict.fromkeys(EVENTS, 0))[parts[1]] += 1
    return dict(sorted(days.items()))


def table(days, title):
    rows = [f"| {title} | " + " | ".join(TITLES[e] for e in EVENTS) + " | Дошли / начали |", "|---|" + "---|" * (len(EVENTS) + 1)]
    return rows


def report(days, today):
    out = ["# Сколько людей пользуется прогулкой", "",
           f"Обновлено: {today}. Считается число запусков, а не людей: один человек, открывший прогулку несколько раз, "
           "посчитается несколько раз. Ничего о человеке не записывается. Откуда цифры — раздел «Счётчик» в README.", ""]
    if not days:
        return "\n".join(out + ["Пока данных нет: счётчик ещё не настроен или никто не открывал прогулку."]) + "\n"
    total = dict.fromkeys(EVENTS, 0)
    for d in days.values():
        for e in EVENTS:
            total[e] += d[e]
    last7 = dict.fromkeys(EVENTS, 0)
    border = (datetime.date.fromisoformat(today) - datetime.timedelta(days=6)).isoformat()
    for k, d in days.items():
        if k >= border:
            for e in EVENTS:
                last7[e] += d[e]
    share = lambda d: f"{round(100 * d['finish'] / d['start'])}%" if d["start"] else "—"
    out += ["## Итоги", "", *table(days, "Период")]
    out += ["| Всё время (с " + next(iter(days)) + ") | " + " | ".join(str(total[e]) for e in EVENTS) + f" | {share(total)} |",
            "| Последние 7 дней | " + " | ".join(str(last7[e]) for e in EVENTS) + f" | {share(last7)} |", ""]
    out += ["## По дням (последние 30)", "", *table(days, "День")]
    for k in sorted(days, reverse=True)[:30]:
        d = days[k]
        out.append(f"| {k} | " + " | ".join(str(d[e]) for e in EVENTS) + f" | {share(d)} |")
    return "\n".join(out) + "\n"


def main():
    folder = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    bucket_file = ROOT / "counter/bucket.txt"
    bucket = bucket_file.read_text(encoding="utf-8").strip() if bucket_file.is_file() else ""
    if not bucket:
        print("Счётчик не настроен: пустой counter/bucket.txt")
        return 1
    days = count(bucket)
    today = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=3)).date().isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "stats.json").write_text(json.dumps(days, ensure_ascii=False, indent=1), encoding="utf-8")
    (folder / "STATS.md").write_text(report(days, today), encoding="utf-8")
    print(f"Дней: {len(days)}, событий: {sum(sum(d.values()) for d in days.values())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
