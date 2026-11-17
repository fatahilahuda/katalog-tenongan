// Ambil foto dari album Google Photos yang dibagikan "siapa saja yang punya link".
// Dipakai bersama oleh server.js (lokal) dan Edge Function Supabase (online).
// Google tidak menyediakan API publik untuk album bersama, jadi daftar foto dibaca dari halaman album
// (alamat foto lh3.googleusercontent.com/pw/...). Hanya host Google di bawah ini yang boleh diambil.

export class GPhotosError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ALBUM_HOSTS = new Set(["photos.app.goo.gl", "photos.google.com", "goo.gl"]);
const PHOTO_RE = /^https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+$/;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const MAX_PAGE = 8 * 1024 * 1024;
const MAX_PAGES = 20; // 300 foto per halaman -> maks ~6000 foto

// Ikuti redirect satu per satu supaya setiap langkah tetap di host yang diizinkan.
async function fetchAllowed(url, allowed) {
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !allowed(u)) throw new GPhotosError(400, "Link bukan album Google Photos");
    const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": UA, "Accept-Language": "id,en;q=0.8" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), u).href; continue; }
    return r;
  }
  throw new GPhotosError(502, "Terlalu banyak pengalihan dari Google Photos");
}

const isAlbumUrl = (u) =>
  ALBUM_HOSTS.has(u.hostname) && (u.hostname !== "goo.gl" || u.pathname.startsWith("/photos/"));

export const PHOTO_ID_RE = /^[A-Za-z0-9_-]{8,200}$/;
// item album: ["<id foto>", ["<alamat foto>", lebar, tinggi, ...], ...]; id dipakai sebagai kunci label AI.
const photoOf = (item) => {
  const [src, w, h] = (Array.isArray(item) && Array.isArray(item[1]) && item[1]) || [];
  const id = Array.isArray(item) && PHOTO_ID_RE.test(item[0]) ? item[0] : "";
  return id && PHOTO_RE.test(src) ? { id, src, w: +w || 0, h: +h || 0 } : null;
};

// Halaman album hanya memuat 300 foto pertama; sisanya diminta per halaman lewat RPC "snAcKc"
// (permintaan yang sama dengan yang dilakukan halaman Google Photos sendiri).
async function nextPage(albumId, key, token) {
  const body = new URLSearchParams({ "f.req": JSON.stringify([[["snAcKc", JSON.stringify([albumId, token, null, key]), null, "generic"]]]) });
  const r = await fetch("https://photos.google.com/_/PhotosUi/data/batchexecute", {
    method: "POST", body, redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  if (!r.ok) throw new GPhotosError(502, "Sebagian album gagal dimuat dari Google Photos");
  const line = (await r.text()).split("\n").find((l) => l.includes('"wrb.fr"'));
  try { return JSON.parse(JSON.parse(line)[0][2]); } catch { throw new GPhotosError(502, "Format album Google Photos tidak dikenali"); }
}

// link album -> { title, photos: [{ id, src, w, h }] }; src adalah alamat dasar tanpa ukuran (tambahkan "=w400" dst.)
export async function listAlbum(link) {
  let start;
  try { start = new URL(String(link || "").trim()); } catch { throw new GPhotosError(400, "Link album tidak valid"); }
  const r = await fetchAllowed(start.href, isAlbumUrl);
  const closed = "Album tidak bisa dibuka. Pastikan link dibagikan ke \"siapa saja yang memiliki link\".";
  if (!r.ok) throw new GPhotosError(r.status === 404 ? 404 : 502, closed);
  const html = await r.text();
  if (html.length > MAX_PAGE) throw new GPhotosError(413, "Album terlalu besar");

  // Data album ada di skrip halaman: AF_initDataCallback({key: 'ds:1', ..., data:[null,[foto...],token,[info album],...]})
  const a = html.indexOf("AF_initDataCallback({key: 'ds:1'");
  const b = html.indexOf("data:", a), e = html.indexOf(", sideChannel", b);
  const req = html.match(/'ds:1'\s*:\s*\{id:'snAcKc'[^}]*?request:(\[[^\]]*\])/);
  let d, albumId, key;
  try { d = JSON.parse(html.slice(b + 5, e)); [albumId, , , key] = JSON.parse(req[1]); }
  catch { throw new GPhotosError(404, closed); }

  const title = String((Array.isArray(d[3]) && d[3][1]) || "");
  const photos = [], seen = new Set();
  const add = (items) => { for (const it of Array.isArray(items) ? items : []) { const p = photoOf(it); if (p && !seen.has(p.src)) { seen.add(p.src); photos.push(p); } } };
  add(d[1]);
  for (let token = d[2], page = 0; token && page < MAX_PAGES; page++) {
    const next = await nextPage(albumId, key, token);
    add(next[1]);
    token = next[2];
  }
  if (!photos.length) throw new GPhotosError(404, "Album ini belum berisi foto.");
  return { title, photos };
}

// alamat foto dari listAlbum -> { bytes: Uint8Array, type }; diperkecil oleh Google ke maks `size` px
export async function fetchPhoto(src, size = 1000) {
  src = String(src || "");
  if (!PHOTO_RE.test(src)) throw new GPhotosError(400, "Alamat foto tidak valid");
  const r = await fetchAllowed(`${src}=w${size}-h${size}`, (u) => u.hostname.endsWith(".googleusercontent.com"));
  if (!r.ok) throw new GPhotosError(502, "Foto tidak bisa diambil dari Google Photos");
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { bytes, type: (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase() };
}
