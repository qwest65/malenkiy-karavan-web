#!/usr/bin/env python3
"""Заливает сайт на хостинг по FTPS — только изменённые файлы.

На сервере рядом с сайтом лежит .deploy-manifest.json: какие файлы и с какой контрольной
суммой уже залиты. Скрипт сравнивает его с файлами репозитория, заливает новые и изменённые,
удаляет с сервера те, что убрали из репозитория, и обновляет список.

Хостинг после сотни быстрых загрузок подряд временно отказывает в соединении для передачи
(«425 Unable to build data connection»). Тогда скрипт ждёт, переподключается и продолжает;
список залитого сохраняется по ходу, так что упавший запуск следующий продолжит с того же места.

    FTP_SERVER=… FTP_USERNAME=… FTP_PASSWORD=… python3 tools/deploy_ftp.py

Запускается в GitHub Actions (.github/workflows/deploy.yml).
"""
import ftplib
import hashlib
import io
import json
import os
import ssl
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ".deploy-manifest.json"
# Что на хостинг не нужно: инструменты, проверки, служебное.
SKIP_PREFIXES = (".git", "tools/", "tests/", "reviews/", "samples/")
SKIP_FILES = {"README.md", "CNAME"}
PAUSE = 0.3          # секунды между файлами — чтобы реже упираться в ограничение хостинга
SAVE_EVERY = 40      # как часто сохранять список залитого
WAITS = [15, 30, 60, 90, 120, 180]  # сколько ждать перед повтором после отказа


def site_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True).stdout
    files = []
    for name in out.decode().split("\0"):
        if not name or name in SKIP_FILES or name.startswith(SKIP_PREFIXES) or "__pycache__" in name:
            continue
        files.append(name)
    return sorted(files)


def digest(name):
    return hashlib.sha1((ROOT / name).read_bytes()).hexdigest()


class Server:
    def __init__(self):
        self.host = os.environ["FTP_SERVER"]
        self.user = os.environ["FTP_USERNAME"]
        self.password = os.environ["FTP_PASSWORD"]
        self.ftp = None
        self.dirs = set()

    def connect(self):
        self.close()
        # Сертификат FTP-сервера хостинга самоподписанный — проверить его нечем.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ftp = ftplib.FTP_TLS(context=ctx, timeout=60)
        ftp.connect(self.host, 21)
        ftp.login(self.user, self.password)
        ftp.prot_p()
        self.ftp = ftp
        self.dirs = set()

    def close(self):
        if self.ftp:
            try:
                self.ftp.quit()
            except Exception:  # noqa: BLE001
                pass
        self.ftp = None

    def retry(self, what, action):
        for attempt, wait in enumerate([0] + WAITS):
            if wait:
                print(f"  ждём {wait} с и переподключаемся…", flush=True)
                time.sleep(wait)
                try:
                    self.connect()
                except Exception as e:  # noqa: BLE001
                    print(f"  не подключились: {e}", flush=True)
                    continue
            try:
                return action()
            except ftplib.error_perm:
                raise
            except Exception as e:  # noqa: BLE001
                print(f"  {what}: {e}", flush=True)
        raise SystemExit(f"Не получилось: {what}")

    def ensure_dir(self, path):
        parts = path.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            d = "/".join(parts[:i])
            if d in self.dirs:
                continue
            try:
                self.ftp.mkd(d)
            except ftplib.error_perm:
                pass  # уже есть
            self.dirs.add(d)

    def upload(self, name, data):
        def go():
            self.ensure_dir(name)
            self.ftp.storbinary(f"STOR {name}", io.BytesIO(data))
        self.retry(name, go)

    def delete(self, name):
        def go():
            try:
                self.ftp.delete(name)
            except ftplib.error_perm:
                pass  # уже нет
        self.retry(f"удалить {name}", go)

    def read_manifest(self):
        buf = io.BytesIO()

        def go():
            try:
                self.ftp.retrbinary(f"RETR {MANIFEST}", buf.write)
                return json.loads(buf.getvalue() or b"{}")
            except ftplib.error_perm:
                return {}  # первый запуск
        return self.retry("прочитать список залитого", go)

    def save_manifest(self, manifest):
        data = json.dumps(manifest, indent=0, sort_keys=True).encode()
        self.retry("сохранить список залитого",
                   lambda: self.ftp.storbinary(f"STOR {MANIFEST}", io.BytesIO(data)))


def main():
    files = site_files()
    wanted = {name: digest(name) for name in files}
    server = Server()
    server.connect()
    done = server.read_manifest()

    todo = [name for name in files if done.get(name) != wanted[name]]
    gone = [name for name in done if name not in wanted]
    print(f"Файлов на сайте: {len(files)}; залить: {len(todo)}; удалить: {len(gone)}", flush=True)

    for i, name in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {name}", flush=True)
        server.upload(name, (ROOT / name).read_bytes())
        done[name] = wanted[name]
        if i % SAVE_EVERY == 0:
            server.save_manifest(done)
        time.sleep(PAUSE)

    for name in gone:
        print(f"удаляем {name}", flush=True)
        server.delete(name)
        done.pop(name, None)

    if todo or gone:
        server.save_manifest(done)
    server.close()
    print("Готово.", flush=True)


if __name__ == "__main__":
    sys.exit(main())
