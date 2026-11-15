#!/usr/bin/env bash
# Создаёт релиз на GitHub (Releases) для слияния PR в ветку new-site: метку, к которой можно откатиться.
# Версия берётся из "version" в data/site.json. Метка:
#   site-v0.2 — если версия новая;
#   site-v0.2.1, site-v0.2.2 … — если версия та же, а изменились тексты, картинки, вёрстка.
# Приставка site-v нужна, потому что в этом репозитории есть релизы основного сайта (v1.29…).
# Релиз НЕ помечается «последним» (--latest=false): иначе он подменил бы ссылки вида …/releases/latest/…
# основного сайта. Нужен GH_TOKEN (в workflow — встроенный). Откат на метку: README, раздел «Версии и откат».
set -euo pipefail

has() { gh release view "$1" >/dev/null 2>&1; }

VER="$(python3 -c "import json;print(json.load(open('data/site.json',encoding='utf-8'))['version'])")"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
if git tag --points-at "$SHA" | grep -q '^site-v'; then echo "У этого коммита уже есть метка версии"; exit 0; fi
PR="$(git log -1 --format=%b "$SHA" | grep -m1 . || git log -1 --format=%s "$SHA")"
tag="site-v$VER"; k=0
while has "$tag" || git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do k=$((k + 1)); tag="site-v$VER.$k"; done
gh release create "$tag" --target "$SHA" --latest=false --generate-notes --title "${tag#site-v} · $PR" \
  --notes "$PR"$'\n\n'"Откатить сайт на эту версию: README, раздел «Версии и откат»."
echo "Создан релиз $tag"
