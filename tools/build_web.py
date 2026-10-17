#!/usr/bin/env python3
"""Обновляет данные веб-версии из Android-приложения «Маленький караван».

Тексты, вопросы, пешеходные линии, наклейки и озвучка живут в репозитории
Android-приложения (qwest65/malenkiy-karavan). Скрипт копирует их сюда, добавляет
к точкам координаты из каталога мест и перекодирует озвучку в MP3 (Safari на
iPhone не везде играет Ogg Vorbis). Запускать после правок в Android-приложении:

    git clone https://github.com/qwest65/malenkiy-karavan ../malenkiy-karavan
    pip install soundfile numpy lameenc
    python tools/build_web.py ../malenkiy-karavan

Затем увеличить VERSION в sw.js, чтобы телефоны забрали новые файлы.
"""
import json
import shutil
import sys
from pathlib import Path

import lameenc
import numpy as np
import soundfile as sf

OUT = Path(__file__).resolve().parents[1]
ANDROID = Path(sys.argv[1] if len(sys.argv) > 1 else OUT.parent / "malenkiy-karavan").resolve()
KIDS = ANDROID / "app/src/main/assets/kids"
CATALOG = ANDROID / "core/src/main/assets/catalog.json"

MP3_KBPS = 64


def build_route():
    route = json.loads((KIDS / "route.json").read_text(encoding="utf-8"))
    places = {p["id"]: p for p in json.loads(CATALOG.read_text(encoding="utf-8"))["places"]}
    for stop in route["stops"]:
        place = places[stop["place_id"]]
        stop["lat"], stop["lon"] = place["lat"], place["lon"]
    data = OUT / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "route.json").write_text(json.dumps(route, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    shutil.copy(KIDS / "paths.json", data / "paths.json")
    shutil.copy(KIDS / "streets.json", data / "streets.json")


def build_stickers():
    out = OUT / "stickers"
    out.mkdir(parents=True, exist_ok=True)
    for f in sorted((KIDS / "stickers").glob("*.webp")):
        shutil.copy(f, out / f.name)


def to_mp3(src: Path, dst: Path):
    audio, rate = sf.read(src, dtype="int16", always_2d=True)
    mono = audio.mean(axis=1).astype(np.int16)
    enc = lameenc.Encoder()
    enc.set_bit_rate(MP3_KBPS)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    dst.write_bytes(enc.encode(mono.tobytes()) + enc.flush())


def build_audio():
    out = OUT / "audio"
    out.mkdir(parents=True, exist_ok=True)
    for f in sorted((KIDS / "audio").glob("*.ogg")):
        to_mp3(f, out / (f.stem + ".mp3"))


def build_file_list():
    """Список наклеек и озвучки, которые sw.js сохраняет в телефон для работы без интернета."""
    files = [f"stickers/{f.name}" for f in sorted((OUT / "stickers").glob("*.webp"))]
    files += [f"audio/{f.name}" for f in sorted((OUT / "audio").glob("*.mp3"))]
    (OUT / "data/files.json").write_text(json.dumps(files, indent=0), encoding="utf-8")


if __name__ == "__main__":
    build_route()
    build_stickers()
    build_audio()
    build_file_list()
    print("Готово:", OUT)
