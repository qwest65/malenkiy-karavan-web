#!/usr/bin/env python3
"""Обновляет data/files.json — список наклеек, озвучки и карты, которые sw.js сохраняет в телефон
для работы без интернета. Запускать после того, как добавили, убрали или переименовали
файлы в stickers/ или audio/ (переозвучка из tools/generate_audio.py и сборка карты
tools/build_map.py делают это сами).

    python3 tools/update_files.py

Затем увеличить VERSION в sw.js, чтобы телефоны забрали новые файлы.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def update_files():
    files = [f"stickers/{f.name}" for f in sorted((ROOT / "stickers").glob("*.webp"))]
    files += [f"audio/{f.name}" for f in sorted((ROOT / "audio").glob("*.mp3"))]
    files += [f.relative_to(ROOT).as_posix() for f in sorted((ROOT / "map").rglob("*")) if f.is_file()]
    (ROOT / "data/files.json").write_text(json.dumps(files, indent=0), encoding="utf-8")
    print(f"data/files.json: {len(files)} файлов")


if __name__ == "__main__":
    update_files()
