#!/usr/bin/env bash
# Создаёт релизы на GitHub (Releases): метку версии, к которой можно откатиться или обновиться.
# Запускается workflow «Release» после каждого слияния PR в main. Сначала (один раз, повторно ничего не меняет)
# отмечает прошлые версии 1.24…1.29, потом создаёт релиз для нового слияния:
#   v1.30 — если версия приложения (APP_VERSION в progulka/app.js) новая;
#   v1.30.1, v1.30.2 … — если версия та же, а изменился сайт, страница Троши, тексты и т. п.
# Нужен GH_TOKEN (в workflow — встроенный). Откат на метку: см. README, раздел «Версии и откат».
set -euo pipefail

has() { gh release view "$1" >/dev/null 2>&1; }

# версия сборка-коммит: коротко записано, что было в этой версии (из истории версий в README)
backfill() {
  local ver="$1" tag="v$1" sha="$2" extra="${3:-}"
  has "$tag" && return 0
  local row; row="$(git show "$sha:README.md" 2>/dev/null | grep -m1 "^| ${ver} |" | sed -E "s/^\| ${ver} \| //; s/ \|\$//" || true)"
  [ -n "$row" ] || row="$(git log -1 --format=%s "$sha")"
  gh release create "$tag" --target "$sha" --latest=false --title "Веб-версия ${ver}" \
    --notes "${row}${extra}"$'\n\n'"Выпущено задним числом: метка поставлена на коммит ${sha:0:7}."
}
backfill 1.24 3520fae9f0d9ee199acaa45f133d2bfe42825e7e
backfill 1.25 9211904cc2f5947a9851b2d11d5cbcc77f346b6b
backfill 1.26 0b24b1ecf8c87782e3c455da43c57e80f23d8b86
backfill 1.27 64a6b49dc0ec9f983509f1620cb9aea92cf67da5
backfill 1.28 59dea4c9fedcfa2242720f7253be09090bf3e72c
backfill 1.29 818b2b30b87dcb78a611d2247309b290d3431b01

# страница «Троша на экране» с новым сценарием из пяти реплик (PR 78–82)
if ! has v1.29.1; then
  gh release create v1.29.1 --target 01703645bae5d3d84721e7c8108e7e0dfa54c160 --latest=false \
    --title "1.29.1 · Троша на панели: новый сценарий, фото трёх мест" \
    --notes "Версия приложения 1.29, страница «Троша на экране панели»: пять новых реплик, чёрный экран после «Сейчас попробую», фото собора, медресе Расулья, торговых рядов и пассажа Яушевых, Троша остаётся на экране в конце. Выпущено задним числом."
fi

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
