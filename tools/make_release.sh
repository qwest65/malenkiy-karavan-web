#!/usr/bin/env bash
# Создаёт релизы на GitHub (Releases): метку версии, к которой можно откатиться или обновиться.
# Запускается workflow «Release» после каждого слияния PR в main и создаёт релиз для этого слияния:
#   v1.30 — если версия приложения (APP_VERSION в progulka/app.js) новая;
#   v1.30.1, v1.30.2 … — если версия та же, а изменился сайт, страница Троши, тексты и т. п.
# Нужен GH_TOKEN (в workflow — встроенный). Откат на метку: см. README, раздел «Версии и откат».
# Прошлые версии задним числом отметить нельзя: GitHub не даёт рабочему процессу (у его токена нет права `workflows`)
# создавать метки на старых коммитах, где менялись файлы .github/workflows. На новых слияниях это работает.
set -euo pipefail

has() { gh release view "$1" >/dev/null 2>&1; }

# релиз для текущего слияния
APP="$(grep -m1 -oP "APP_VERSION = '\K[^']+" progulka/app.js)"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
if git tag --points-at "$SHA" | grep -q '^v'; then echo "У этого коммита уже есть метка версии"; exit 0; fi
PR="$(git log -1 --format=%b "$SHA" | grep -m1 . || git log -1 --format=%s "$SHA")"
tag="v$APP"; k=0
while has "$tag" || git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do k=$((k + 1)); tag="v$APP.$k"; done
gh release create "$tag" --target "$SHA" --latest --generate-notes --title "${tag#v} · $PR" \
  --notes "$PR"$'\n\n'"Откатить сайт на эту версию: README, раздел «Версии и откат»."
echo "Создан релиз $tag"
