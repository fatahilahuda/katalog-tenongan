// Service worker katalog: supaya bisa dipasang di HP dan tetap terbuka saat sinyal jelek.
// - Halaman & /api/data : ambil dari jaringan dulu (harga/stok selalu terbaru), pakai cache kalau offline.
// - Foto, ikon, font     : pakai cache dulu (hemat kuota), ambil dari jaringan kalau belum ada.
// - Halaman kasir       : sama seperti halaman katalog (bisa dibuka saat offline; data kasir ada di HP).
// Halaman admin & API admin sengaja TIDAK disentuh (selalu langsung ke jaringan).
// Naikkan VERSION setiap kali index.html / kasir.html diubah agar cache lama dibuang.
const VERSION = "v6";
const PAGES = "pages-" + VERSION;
const ASSETS = "assets-" + VERSION;
const MAX_ASSETS = 300;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(PAGES).then(c => c.addAll(["/", "/manifest.webmanifest"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== PAGES && k !== ASSETS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isFont = url => url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
const isPage = url => ["/", "/index.html", "/api/data", "/manifest.webmanifest", "/kasir/", "/kasir/manifest.webmanifest"].includes(url.pathname);
const isAsset = url => url.pathname.startsWith("/images/") || url.pathname.startsWith("/icons/");
// Foto unggahan admin tersimpan di Supabase Storage (domain lain, publik).
const isStorageImg = url => url.hostname.endsWith(".supabase.co") && url.pathname.includes("/storage/v1/object/public/");

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && isPage(url)) {
    e.respondWith(networkFirst(req, url.pathname === "/index.html" ? "/" : null));
  } else if ((sameOrigin && isAsset(url)) || isFont(url) || isStorageImg(url)) {
    e.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req, key) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res.ok) cache.put(key || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key || req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  // Unduh katalog memuat foto dengan CORS; respons "opaque" dari cache tidak bisa dipakai canvas, jadi ambil ulang.
  if (hit && !(req.mode === "cors" && hit.type === "opaque")) return hit;
  const res = await fetch(req);
  // res.type "opaque" = gambar lintas domain tanpa CORS; tetap disimpan agar tampil saat offline.
  if (res.ok || res.type === "opaque") {
    await cache.put(req, res.clone());
    trim(cache);
  }
  return res;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}
