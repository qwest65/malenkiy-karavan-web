#!/usr/bin/env python3
"""QR-код прогулки для маршрутных листов и листовок: images/qr.png (900×900, Троша в середине).

    pip install qrcode pillow
    python3 tools/make_qr.py

Адрес — в URL ниже. В QR-код он записан латиницей (xn--…): так его прочитает любая камера,
а телефон откроет прогулку на маленький-караван.рф.
"""
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
URL = "https://xn----7sbbaalryjidglrj8b2n.xn--p1ai/progulka/"
SIZE = 900
COLOR = (59, 36, 21)


def main():
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=2)
    qr.add_data(URL)
    qr.make(fit=True)
    img = qr.make_image(fill_color=COLOR, back_color="white").convert("RGB").resize((SIZE, SIZE), Image.NEAREST)

    # Троша в середине: четверть стороны, на белой подложке со скруглёнными углами.
    icon_side = SIZE * 26 // 100
    pad = SIZE // 60
    box = icon_side + 2 * pad
    x = (SIZE - box) // 2
    ImageDraw.Draw(img).rounded_rectangle([x, x, x + box, x + box], radius=box // 5, fill="white")
    icon = Image.open(ROOT / "icons/icon-512.png").convert("RGBA").resize((icon_side, icon_side), Image.LANCZOS)
    mask = Image.new("L", icon.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, icon_side, icon_side], radius=icon_side // 5, fill=255)
    img.paste(icon, (x + pad, x + pad), mask)
    img.save(ROOT / "images/qr.png", optimize=True)
    print(f"images/qr.png → {URL}")


if __name__ == "__main__":
    main()
