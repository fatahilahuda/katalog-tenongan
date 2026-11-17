#!/bin/sh
# Menyusun folder ./deploy yang siap diunggah ke Cloudflare Pages (situs statis + Pages Functions sebagai proxy
# ke Supabase Edge Function). netlify.toml tetap dibuat supaya folder yang sama juga masih bisa dipakai di Netlify.
# Unggah ke Cloudflare: lihat deploy-cloudflare.sh
# Link admin diambil dari config.json ("adminPath") dan harus sama dengan tabel katalog_config di Supabase (key admin_path).
set -e
cd "$(dirname "$0")"
REF="nyvwnpkhzkdtmbwigfoy"
ADMIN=$(python3 -c "import json;print(json.load(open('config.json'))['adminPath'])")
API="https://$REF.supabase.co/functions/v1/catalog"

rm -rf deploy && mkdir -p "deploy/$ADMIN" deploy/images
cp index.html deploy/index.html
cp admin.html "deploy/$ADMIN/index.html"
mkdir -p deploy/kasir && cp kasir.html deploy/kasir/index.html
# aplikasi Admin & Kasir di HP: manifest sendiri-sendiri (alamat admin diisi dari config.json)
cp kasir.webmanifest deploy/kasir/manifest.webmanifest
sed "s/__ADMIN__/$ADMIN/g" admin.webmanifest > "deploy/$ADMIN/manifest.webmanifest"
# PWA (pasang di HP)
cp manifest.webmanifest sw.js deploy/ && cp -r icons deploy/icons
# foto produk statis (foto unggahan admin disimpan di Supabase Storage, bukan di sini)
find images -maxdepth 2 -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' \) -not -path 'images/uploads/*' | while read f; do
  mkdir -p "deploy/$(dirname "$f")"; cp "$f" "deploy/$f"
done

cat > deploy/netlify.toml <<T
# Pengunjung: /api/data -> data publik (hanya produk aktif)
[[redirects]]
  from = "/api/data"
  to = "$API/public"
  status = 200
  force = true

# Admin: /$ADMIN/api/* -> fungsi admin (link admin ikut diperiksa oleh fungsi)
[[redirects]]
  from = "/$ADMIN/api/*"
  to = "$API/a/$ADMIN/:splat"
  status = 200
  force = true

[[headers]]
  for = "/$ADMIN/*"
  [headers.values]
    X-Robots-Tag = "noindex, nofollow"
    Cache-Control = "no-store"

[[headers]]
  for = "/kasir/*"
  [headers.values]
    X-Robots-Tag = "noindex, nofollow"
    Cache-Control = "no-cache"

[[headers]]
  for = "/api/*"
  [headers.values]
    Cache-Control = "no-store"

[[headers]]
  for = "/sw.js"
  [headers.values]
    Cache-Control = "no-cache"

[[headers]]
  for = "/manifest.webmanifest"
  [headers.values]
    Content-Type = "application/manifest+json"
    Cache-Control = "no-cache"

[[headers]]
  for = "/icons/*"
  [headers.values]
    Cache-Control = "public, max-age=86400"

[[headers]]
  for = "/images/*"
  [headers.values]
    Cache-Control = "public, max-age=86400"
T
# ---------- Cloudflare Pages ----------
# Proxy /api/data dan /<admin>/api/* ke Edge Function (Cloudflare Pages tidak bisa proxy lewat _redirects).
# Functions disimpan di luar folder deploy (deploy-cf/functions) supaya tidak ikut terunggah sebagai file publik
# (nama foldernya memuat link admin). wrangler membaca folder functions dari direktori tempat ia dijalankan.
rm -rf deploy-cf && mkdir -p deploy-cf/functions/api "deploy-cf/functions/$ADMIN/api"
cat > deploy-cf/functions/api/data.js <<J
// Pengunjung: data katalog publik (hanya produk aktif)
export const onRequestGet = () => fetch("$API/public").then((r) =>
  new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }));
J
cat > "deploy-cf/functions/$ADMIN/api/[[path]].js" <<J
// Admin: /$ADMIN/api/* -> fungsi admin (link admin ikut diperiksa oleh fungsi)
export async function onRequest({ request, params }) {
  const path = [].concat(params.path || []).map(encodeURIComponent).join("/");
  const init = { method: request.method, headers: { "Content-Type": request.headers.get("Content-Type") || "application/octet-stream" } };
  if (!["GET", "HEAD"].includes(request.method)) init.body = await request.arrayBuffer();
  const r = await fetch("$API/a/$ADMIN/" + path, init);
  return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
J
cat > deploy/_headers <<T
/$ADMIN/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
/kasir/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Content-Type: application/manifest+json
/kasir/manifest.webmanifest
  Content-Type: application/manifest+json
/$ADMIN/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: no-cache
/icons/*
  Cache-Control: public, max-age=86400
/images/*
  Cache-Control: public, max-age=86400
T

# ---------- Hostinger (hosting biasa, tanpa proxy /api) ----------
# Salinan deploy/ yang memanggil Supabase langsung (CORS di Edge Function terbuka). Auto-deploy Hostinger memakai folder ./hostinger.
rm -rf hostinger && cp -r deploy hostinger && rm -f hostinger/netlify.toml hostinger/_headers
sed -i "s#fetch(\"/api/data\"#fetch(\"$API/public\"#" hostinger/index.html hostinger/kasir/index.html
sed -i "s#const r = await fetch(path, opt);#const r = await fetch(path.replace(/^api\\\\//, \"$API/a/$ADMIN/\"), opt);#" "hostinger/$ADMIN/index.html"
cat > hostinger/.htaccess <<'E'
<IfModule mod_headers.c>
  <FilesMatch "^(sw\.js|manifest\.webmanifest)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <If "%{REQUEST_URI} =~ m#^/(adminxx|kasir)/#">
    Header set X-Robots-Tag "noindex, nofollow"
  </If>
</IfModule>
AddType application/manifest+json .webmanifest
E
echo "hostinger/ siap: $(find hostinger -type f | wc -l) file"
echo "deploy/ siap: $(find deploy -type f | wc -l) file, $(du -sh deploy | cut -f1), admin di /$ADMIN/"
