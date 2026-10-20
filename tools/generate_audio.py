#!/usr/bin/env python3
"""Озвучка прогулки «Маленький караван» из data/route.json.

Два движка:

* **edge** — нейросетевые голоса Microsoft Edge («Прочесть вслух») через edge-tts:
  Дмитрий и Светлана. Бесплатно и без ключа, нужен интернет. Это неофициальный
  доступ к сервису Microsoft: для бесплатного приложения подходит, для платного — рискованно.
* **piper** — офлайн-голоса Piper «dmitri» и «denis» (лицензия CC0).

    pip install edge-tts soundfile numpy   # sherpa-onnx — для piper
    python3 tools/generate_audio.py --engine edge --narrator ru-RU-DmitryNeural \\
        --trosha ru-RU-SvetlanaNeural --trosha-pitch +25Hz
    python3 tools/generate_audio.py --engine edge --samples samples/   # образцы голосов
    YANDEX_SPEECHKIT_KEY=… python3 tools/generate_audio.py --yandex-narrator ermil   # только рассказчик
    YANDEX_SPEECHKIT_KEY=… python3 tools/generate_audio.py --site-facts ermil   # ответы на карточках сайта

Сейчас рассказчик озвучен Яндекс SpeechKit (голос ermil), а Троша — ElevenLabs: его фразы
записаны отдельно, и режим --yandex-narrator их не трогает.

Файлы пишутся в audio/*.mp3 (моно, 64 кбит/с — Safari на iPhone не везде играет Ogg),
после чего обновляется data/files.json. Образцы голосов пишутся в Ogg.
В GitHub Actions это делает workflow «Voice» (.github/workflows/voice.yml).
Те же MP3 подходят и Android-приложению.
"""
import argparse
import json
import pathlib
import re
import tarfile
import urllib.request

import numpy as np
import soundfile as sf
from update_files import update_files

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROUTE = ROOT / "data/route.json"
AUDIO = ROOT / "audio"
SITE = ROOT / "site"
MP3_KBPS = 64

# --- Piper -------------------------------------------------------------------------------

PIPER_CACHE = pathlib.Path.home() / ".cache/karavan-voices"
PIPER_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-{}-medium.tar.bz2"
_piper = {}


def piper_engine(voice):
    import sherpa_onnx

    if voice not in _piper:
        folder = PIPER_CACHE / f"vits-piper-ru_RU-{voice}-medium"
        if not folder.exists():
            PIPER_CACHE.mkdir(parents=True, exist_ok=True)
            archive = PIPER_CACHE / f"{voice}.tar.bz2"
            urllib.request.urlretrieve(PIPER_URL.format(voice), archive)
            with tarfile.open(archive) as tar:
                tar.extractall(PIPER_CACHE)
            archive.unlink()
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(folder / f"ru_RU-{voice}-medium.onnx"),
            tokens=str(folder / "tokens.txt"),
            data_dir=str(folder / "espeak-ng-data"),
        )
        config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=4))
        _piper[voice] = sherpa_onnx.OfflineTts(config)
    return _piper[voice]


def piper_say(text, voice, speed):
    audio = piper_engine(voice).generate(text, sid=0, speed=speed)
    return np.asarray(audio.samples, dtype=np.float32), audio.sample_rate


# --- Microsoft Edge ----------------------------------------------------------------------

# Голоса «Прочесть вслух» из Microsoft Edge через библиотеку edge-tts: ключ не нужен.
EDGE_VOICES = {
    "ru-RU-DmitryNeural": ("Дмитрий", "Dmitry"),
    "ru-RU-SvetlanaNeural": ("Светлана", "Svetlana"),
}


def edge_say(text, voice, rate="+0%", pitch="+0Hz", attempts=4):
    import asyncio
    import tempfile
    import time

    import edge_tts

    # Многоточие и длинные тире сервис иногда не озвучивает — заменяем на обычную пунктуацию.
    text = text.replace("…", ".").replace("—", ",")
    with tempfile.TemporaryDirectory() as tmp:
        mp3 = pathlib.Path(tmp) / "speech.mp3"
        for attempt in range(attempts):
            try:
                asyncio.run(edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(str(mp3)))
                break
            except edge_tts.exceptions.EdgeTTSException as error:
                # Сервис Microsoft иногда отвечает пустым потоком — пробуем ещё раз с паузой.
                if attempt == attempts - 1:
                    raise
                print(f"  повтор после ошибки: {error}")
                time.sleep(3 * (attempt + 1))
        samples, rate_hz = sf.read(mp3, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return samples, rate_hz


# --- Яндекс SpeechKit --------------------------------------------------------------------

# Синтез речи Яндекса (API v1), оплата по числу символов. Ключ — в переменной YANDEX_SPEECHKIT_KEY.
YANDEX_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize"
YANDEX_RATE = 48000

# Кандидаты для образцов: (голос, амплуа). Не каждый голос есть в API v1 — недоступные пропускаем.
YANDEX_NARRATORS = [("filipp", None), ("ermil", "good"), ("zahar", "good"), ("alexander", "good"),
                    ("kirill", "good"), ("anton", "good"), ("madirus", None), ("alena", "good"), ("jane", "good")]
YANDEX_TROSHAS = [("alena", "good"), ("jane", "good"), ("masha", "friendly"), ("lera", "friendly"),
                  ("dasha", "friendly"), ("marina", "friendly")]


def yandex_say(text, voice, emotion=None, speed=1.0):
    import os

    import requests

    data = {"text": text, "lang": "ru-RU", "voice": voice, "speed": f"{speed:.2f}",
            "format": "lpcm", "sampleRateHertz": str(YANDEX_RATE)}
    if emotion:
        data["emotion"] = emotion
    r = requests.post(YANDEX_URL, data=data, timeout=60,
                      headers={"Authorization": f"Api-Key {os.environ['YANDEX_SPEECHKIT_KEY'].strip()}"})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    return np.frombuffer(r.content, dtype="<i2").astype(np.float32) / 32768, YANDEX_RATE


def generate_yandex_samples(route, out):
    """Один и тот же фрагмент голосами Яндекса. Первый же запрос проверяет ключ."""
    out.mkdir(parents=True, exist_ok=True)
    stop = route["stops"][1]
    rows, failed = [], []
    jobs = [("narrator", v, e, stop["narrator"], 0.95) for v, e in YANDEX_NARRATORS]
    jobs += [("trosha", v, e, stop["trosha"], 1.1) for v, e in YANDEX_TROSHAS]
    for role, voice, emotion, text, speed in jobs:
        name = f"{role}-{voice}" + (f"-{emotion}" if emotion else "")
        try:
            write(out / f"{name}.ogg", *yandex_say(text, voice, emotion, speed))
            rows.append(f"| {name}.ogg | {'рассказчик' if role == 'narrator' else 'Троша'} | {voice} | {emotion or '—'} |")
        except RuntimeError as error:
            print(f"  {name}: {error}")
            failed.append(f"{name}: {error}")
            if "401" in str(error) or "403" in str(error):
                raise SystemExit(f"Ключ SpeechKit не принят: {error}")
    if not rows:
        raise SystemExit("Ни один голос не озвучил фразу.")
    notes = ["Один и тот же фрагмент (Свято-Троицкий собор) голосами Яндекс SpeechKit (API v1).", "",
             "| Файл | Роль | Голос | Амплуа |", "|---|---|---|---|", *rows]
    if failed:
        notes += ["", "Не получилось (голос недоступен в API v1):", *[f"- {f}" for f in failed]]
    (out / "NOTES.md").write_text("\n".join(notes) + "\n", encoding="utf-8")


def yandex_v3_say(text, voice, role=None, speed=1.0, pitch_shift=None):
    """Новые голоса SpeechKit (API v3): ответ — поток JSON-строк с кусками звука в base64."""
    import base64
    import os

    import requests

    hints = [{"voice": voice}, {"speed": speed}]
    if role:
        hints.append({"role": role})
    if pitch_shift:
        hints.append({"pitchShift": pitch_shift})
    body = {"text": text, "hints": hints, "loudnessNormalizationType": "LUFS",
            "outputAudioSpec": {"rawAudio": {"audioEncoding": "LINEAR16_PCM", "sampleRateHertz": YANDEX_RATE}}}
    r = requests.post("https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis", json=body, timeout=120,
                      headers={"Authorization": f"Api-Key {os.environ['YANDEX_SPEECHKIT_KEY'].strip()}"})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    pcm = b"".join(base64.b64decode(json.loads(line)["result"]["audioChunk"]["data"])
                   for line in r.text.splitlines() if line.strip())
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768, YANDEX_RATE


def generate_yandex_v3_samples(route, out):
    """По одному новому голосу (API v3) для рассказчика и для Троши."""
    out.mkdir(parents=True, exist_ok=True)
    stop = route["stops"][1]
    write(out / "v3-narrator-alexander-good.ogg", *yandex_v3_say(stop["narrator"], "alexander", "good", 0.95))
    try:
        audio = yandex_v3_say(stop["trosha"], "masha", "friendly", 1.1, pitch_shift=200)
    except RuntimeError as error:
        # Если сдвиг тона не принят — тот же голос без него.
        print(f"  сдвиг тона не принят: {error}")
        audio = yandex_v3_say(stop["trosha"], "masha", "friendly", 1.1)
    write(out / "v3-trosha-masha-friendly.ogg", *audio)


def generate_yandex_v3_trosha(route, out):
    """Варианты Троши: голос выше и выше, чтобы звучал по-детски."""
    out.mkdir(parents=True, exist_ok=True)
    text = route["stops"][1]["trosha"]
    for voice, shift in (("masha", 400), ("masha", 700), ("masha", 1000), ("marina", 700)):
        try:
            write(out / f"v3-trosha-{voice}-up{shift}.ogg", *yandex_v3_say(text, voice, "friendly", 1.1, shift))
        except RuntimeError as error:
            print(f"  {voice} +{shift}: {error}")
    # Тот же голос, поднятый на 4 полутона уже у нас (librosa), — для сравнения.
    import librosa

    samples, rate = yandex_v3_say(text, "masha", "friendly", 1.1)
    write(out / "v3-trosha-masha-plus4semitones.ogg",
          librosa.effects.pitch_shift(samples, sr=rate, n_steps=4).astype(np.float32), rate)


# Ударения для Яндекса: «+» перед ударной гласной. Слова — те же, что синтезаторы читали неверно.
YANDEX_STRESS = {
    r"реки": "рек+и",
    r"города": "г+орода",
    r"двадцатого": "двадц+атого",
    r"Троицк(\w*)": "Тр+оицк\\1",
    r"гербе": "г+ербе",
    r"казаки": "казак+и",
    r"сыром": "с+ыром",
    r"ворону": "вор+ону",
}


def yandex_text(text):
    for written, spoken in SPOKEN.items():
        text = text.replace(written, spoken)
    for word, spoken in YANDEX_STRESS.items():
        pattern = re.compile(rf"\b{word}\b", re.IGNORECASE)

        def keep_case(match, spoken=spoken, pattern=pattern):
            out = pattern.sub(spoken, match.group(0).lower())
            return out[0].upper() + out[1:] if match.group(0)[0].isupper() else out

        text = pattern.sub(keep_case, text)
    return text.replace("…", ".")


def yandex_chunks(text, limit=240):
    """Длинную справку режем по предложениям: так надёжнее для API v3."""
    parts, cur = [], ""
    for sentence in re.split(r"(?<=[.!?…])\s+", text):
        if cur and len(cur) + 1 + len(sentence) > limit:
            parts.append(cur)
            cur = sentence
        else:
            cur = f"{cur} {sentence}".strip()
    if cur:
        parts.append(cur)
    return parts


def yandex_narrate(text, voice, role):
    pieces = []
    rate = YANDEX_RATE
    for chunk in yandex_chunks(yandex_text(text)):
        samples, rate = yandex_v3_say(chunk, voice, role, 1.0)
        pieces += [samples, np.zeros(int(rate * 0.25), dtype=np.float32)]
    return np.concatenate(pieces[:-1]), rate


def generate_yandex_narrator(route, voice, role):
    """Переозвучивает только рассказчика (рассказы, вопросы, справки для взрослых). Троша не трогается."""
    for n, stop in enumerate(route["stops"], start=1):
        write(AUDIO / f"stop{n}_narrator.mp3", *yandex_narrate(stop["narrator"], voice, role), tail=PAUSE)
        write(AUDIO / f"stop{n}_task.mp3", *yandex_narrate(stop["question"]["voice"], voice, role), tail=PAUSE)
        write(AUDIO / f"stop{n}_parent.mp3", *yandex_narrate(stop["parent_story"], voice, role), tail=PAUSE)


def site_facts():
    """Ответы с карточек «Знаешь ли ты?» на сайте проекта — по порядку карточек."""
    page = (SITE / "index.html").read_text(encoding="utf-8")
    backs = re.findall(r'<span class="side back">(?:<img[^>]*>)?<span>(.*?)</span></span>', page, re.S)
    return [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", b)).strip() for b in backs]


def generate_site_facts(voice, role):
    """Озвучивает ответы на карточках сайта: site/audio/fact1.mp3, fact2.mp3…"""
    for n, text in enumerate(site_facts(), start=1):
        write(SITE / "audio" / f"fact{n}.mp3", *yandex_narrate(text, voice, role))


# --- Общее -------------------------------------------------------------------------------

# Ударения, которые синтезатор ставит неверно. Знак ударения (U+0301) добавляется только
# в озвучиваемый текст — на экране слова остаются без него.
# Римские века синтезатор читает как «восемнадцать веке» — заменяем словами.
SPOKEN = {
    "XVIII–XIX веках": "восемнадцатом и девятнадцатом веках",
    "XVIII веке": "восемнадцатом веке",
    "XIX веке": "девятнадцатом веке",
    "XIX века": "девятнадцатого века",
    "XX века": "двадцатого века",
    # Инициалы синтезатор читает по буквам — в озвучке называем полностью (на экране остаются инициалы).
    "И. И. Неплюевым": "Иваном Ивановичем Неплюевым",
    "И. И. Неплюев": "Иван Иванович Неплюев",
    "И. А. Деколонга": "Ивана Александровича Деколонга",
    "И. А. Крылову": "Ивану Андреевичу Крылову",
}

STRESS = {
    # «Две реки́»: одного знака ударения синтезатору мало, поэтому пишем как слышится.
    r"реки": "рики́",
    r"города": "го́рода",
    r"двадцатого": "двадца́того",
    r"Троицкой": "Тро́йцкой",
    r"гербе": "ге́рбе",
    r"Троицк(\w*)": "Тро́ицк\\1",
    r"казаки": "казаки́",
    r"сыром": "сы́ром",
    r"ворону": "воро́ну",
}


def with_stress(text):
    for written, spoken in SPOKEN.items():
        text = text.replace(written, spoken)
    for word, spoken in STRESS.items():
        pattern = re.compile(rf"\b{word}\b", re.IGNORECASE)

        def keep_case(match, spoken=spoken, pattern=pattern):
            out = pattern.sub(spoken, match.group(0).lower())
            return out[0].upper() + out[1:] if match.group(0)[0].isupper() else out

        text = pattern.sub(keep_case, text)
    return text


def tighten(samples, rate, keep=0.25, frame=0.02, threshold_db=-40):
    """Обрезает тишину по краям и укорачивает длинные паузы внутри до [keep] секунд."""
    step = int(rate * frame)
    frames = len(samples) // step
    if frames == 0:
        return samples
    energy = np.sqrt(np.mean(samples[: frames * step].reshape(frames, step) ** 2, axis=1))
    loud = energy > max(float(energy.max()), 1e-6) * 10 ** (threshold_db / 20)
    if not loud.any():
        return samples
    first, last = int(np.argmax(loud)), frames - int(np.argmax(loud[::-1]))
    keep_frames = int(keep / frame)
    parts, quiet = [], 0
    for i in range(first, last):
        quiet = 0 if loud[i] else quiet + 1
        if quiet <= keep_frames:
            parts.append(samples[i * step:(i + 1) * step])
    return np.concatenate(parts)



def pitch_up(samples, factor):
    """Поднимает тон пересэмплированием (речь при этом немного ускоряется)."""
    if factor == 1.0:
        return samples
    return np.interp(np.arange(0, len(samples) - 1, factor), np.arange(len(samples)), samples).astype(np.float32)


def to_mp3(path, samples, rate):
    import lameenc

    enc = lameenc.Encoder()
    enc.set_bit_rate(MP3_KBPS)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    path.write_bytes(enc.encode(pcm.tobytes()) + enc.flush())


def write(path, samples, rate, tail=0.05):
    samples = tighten(samples, rate)
    peak = max(float(np.abs(samples).max()), 1e-6)
    pad = np.zeros(int(rate * 0.05), dtype=np.float32)
    # Тишина в конце фразы — пауза перед следующим фрагментом (рассказчик → Троша → вопрос).
    data = np.concatenate([pad, samples / peak * 0.9, np.zeros(int(rate * tail), dtype=np.float32)])
    if path.suffix == ".mp3":
        to_mp3(path, data, rate)
    else:
        sf.write(path, data, rate, format="OGG", subtype="VORBIS")
    print(f"{path.name}  {len(data) / rate:.1f} с")


class Voices:
    def __init__(self, args):
        self.args = args

    def narrator(self, text):
        a = self.args
        if a.engine == "edge":
            return edge_say(with_stress(text), a.narrator, rate=a.narrator_rate)
        return piper_say(text, a.narrator or "dmitri", speed=0.9)

    def trosha(self, text):
        a = self.args
        if a.engine == "edge":
            return edge_say(with_stress(text), a.trosha, rate=a.trosha_rate, pitch=a.trosha_pitch)
        # У Piper нет детского голоса: взрослый голос заранее замедляется и поднимается в тоне.
        pitch = 1.35
        samples, rate = piper_say(text, a.trosha or "denis", speed=1.0 / pitch)
        return pitch_up(samples, pitch), rate


def bell(rate=22050):
    """Звон караванного колокольчика: три удара с затухающими обертонами."""
    t = np.arange(int(rate * 1.6)) / rate
    strike = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * d)
                 for f, a, d in [(1320, 1.0, 3.0), (2640, 0.5, 5.0), (3960, 0.25, 7.0), (880, 0.3, 2.5)])
    out = np.zeros(int(rate * 2.4), dtype=np.float32)
    for start in (0.0, 0.35, 0.7):
        i = int(start * rate)
        out[i:i + len(strike)] += strike[: len(out) - i]
    write(AUDIO / "bell.mp3", out, rate)


PAUSE = 0.6


def generate_all(route, voices):
    AUDIO.mkdir(parents=True, exist_ok=True)

    def trosha(name, text):
        write(AUDIO / f"{name}.mp3", *voices.trosha(text), tail=PAUSE)

    def narrator(name, text):
        write(AUDIO / f"{name}.mp3", *voices.narrator(text), tail=PAUSE)

    trosha("intro_trosha", route["intro"]["trosha"])
    trosha("finale_trosha", route["finale"]["trosha"])
    for key, text in route["phrases"].items():
        trosha(f"phrase_{key}", text)
    for n, stop in enumerate(route["stops"], start=1):
        narrator(f"stop{n}_narrator", stop["narrator"])
        trosha(f"stop{n}_trosha", stop["trosha"])
        narrator(f"stop{n}_task", stop["question"]["voice"])
        # «Подробная история голосом» для взрослых: справка о месте (поле parent_story).
        narrator(f"stop{n}_parent", stop["parent_story"])
    bell()


def generate_samples(route, out):
    """Один и тот же фрагмент разными голосами Edge — чтобы выбрать на слух."""
    out.mkdir(parents=True, exist_ok=True)
    stop = route["stops"][1]
    for voice, (_, latin) in EDGE_VOICES.items():
        write(out / f"{latin}-narrator.ogg", *edge_say(stop["narrator"], voice, rate="-5%"))
        # Троша — детский голос: тот же голос выше и чуть быстрее.
        for label, pitch in (("trosha", "+0Hz"), ("trosha-higher", "+25Hz"), ("trosha-highest", "+45Hz")):
            write(out / f"{latin}-{label}.ogg", *edge_say(stop["trosha"], voice, rate="+8%", pitch=pitch))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=["piper", "edge"], default="piper")
    parser.add_argument("--narrator", help="голос рассказчика (edge: ru-RU-DmitryNeural; piper: dmitri)")
    parser.add_argument("--narrator-rate", default="+0%", help="edge: скорость рассказчика, например -5%%")
    parser.add_argument("--trosha", help="голос Троши (edge: ru-RU-SvetlanaNeural; piper: denis)")
    parser.add_argument("--trosha-rate", default="+10%", help="edge: скорость Троши")
    parser.add_argument("--trosha-pitch", default="+25Hz", help="edge: тон Троши, например +25Hz")
    parser.add_argument("--samples", type=pathlib.Path, help="вместо озвучки — образцы голосов Edge в эту папку")
    parser.add_argument("--yandex-samples", type=pathlib.Path, help="образцы голосов Яндекс SpeechKit в эту папку")
    parser.add_argument("--yandex-v3-samples", type=pathlib.Path, help="образцы новых голосов SpeechKit (API v3)")
    parser.add_argument("--yandex-v3-trosha", type=pathlib.Path, help="варианты Троши с поднятым тоном (API v3)")
    parser.add_argument("--yandex-narrator", help="переозвучить только рассказчика голосом Яндекса, например ermil")
    parser.add_argument("--yandex-role", default="neutral", help="амплуа голоса Яндекса")
    parser.add_argument("--site-facts", help="озвучить ответы на карточках сайта голосом Яндекса, например ermil")
    args = parser.parse_args()
    if args.engine == "edge":
        args.narrator = args.narrator or "ru-RU-DmitryNeural"
        args.trosha = args.trosha or "ru-RU-SvetlanaNeural"
    route = json.loads(ROUTE.read_text(encoding="utf-8"))
    if args.site_facts:
        generate_site_facts(args.site_facts, args.yandex_role)
    elif args.yandex_narrator:
        generate_yandex_narrator(route, args.yandex_narrator, args.yandex_role)
        update_files()
    elif args.yandex_v3_trosha:
        generate_yandex_v3_trosha(route, args.yandex_v3_trosha)
    elif args.yandex_v3_samples:
        generate_yandex_v3_samples(route, args.yandex_v3_samples)
    elif args.yandex_samples:
        generate_yandex_samples(route, args.yandex_samples)
    elif args.samples:
        generate_samples(route, args.samples)
    else:
        generate_all(route, Voices(args))
        update_files()


if __name__ == "__main__":
    main()
