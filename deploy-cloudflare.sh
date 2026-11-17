#!/bin/sh
# Unggah folder ./deploy ke Cloudflare Pages (project "katalog-tenongan"), sama seperti wedding-app.
# Butuh: CLOUDFLARE_API_TOKEN (izin Cloudflare Pages: Edit) dan CLOUDFLARE_ACCOUNT_ID di environment,
# atau file .cloudflare-token di folder ini. Jalankan build-deploy.sh dulu.
set -e
cd "$(dirname "$0")"
PROJECT="katalog-tenongan"
[ -n "$CLOUDFLARE_API_TOKEN" ] || CLOUDFLARE_API_TOKEN=$(tr -d '\n\r ' < .cloudflare-token)
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-c10bf0d0974c401abaa891e9c78697b0}"
# wrangler tidak mendukung Termux (platform "android"); paket Linux arm64 jalan dengan menyamarkan platform.
WR=/tmp/wr
if [ ! -d "$WR/node_modules/wrangler" ]; then
  mkdir -p "$WR" && (cd "$WR" && npm i wrangler@4 --os=linux --cpu=arm64 --ignore-scripts --no-audit --no-fund)
fi
echo 'Object.defineProperty(process, "platform", { value: "linux" });' > "$WR/linux.cjs"
wr() { node -r "$WR/linux.cjs" "$WR/node_modules/wrangler/bin/wrangler.js" "$@"; }
wr pages project list | grep -q " $PROJECT " || wr pages project create "$PROJECT" --production-branch main --force
(cd deploy-cf && wr pages deploy ../deploy --project-name "$PROJECT" --branch main --commit-dirty=true)
