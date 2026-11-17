// Server katalog: tanpa dependensi. Jalankan: node server.js
// - Pengunjung : http://localhost:PORT/
// - Admin      : http://localhost:PORT/<adminPath>/   (adminPath ada di config.json)
// Tidak ada login: satu-satunya "kunci" adalah link admin yang dirahasiakan.
// Karena itu semua endpoint tulis (simpan data, upload foto) HANYA ada di bawah link admin.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const IMG_DIR = path.join(ROOT, "images");
const ICON_DIR = path.join(ROOT, "icons");
const UPLOAD_DIR = path.join(IMG_DIR, "uploads");
const DATA_FILE = path.join(ROOT, "data.json");
const BACKUP_FILE = path.join(ROOT, "data.backup.json");
const LABEL_FILE = path.join(ROOT, "gphotos-labels.json"); // label AI foto Google Photos: { id: { l: label, p: produk, m: koreksi manual } }
const REFS_FILE = path.join(ROOT, "gphotos-refs.json");    // lembar contoh foto produk untuk AI: { at, names, sheets: [base64 JPEG] }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = +process.env.PORT || cfg.port || 8000;
const ADMIN = String(process.env.ADMIN_PATH || cfg.adminPath || "").replace(/^\/+|\/+$/g, "");
if (!/^[A-Za-z0-9_-]{4,64}$/.test(ADMIN)) {
  console.error('adminPath di config.json harus 4-64 karakter: huruf, angka, "-" atau "_".');
  process.exit(1);
}
const A = "/" + ADMIN;

const MIME = {
  ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const UPLOAD_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const EXT_TYPES = Object.fromEntries(Object.entries(UPLOAD_TYPES).map(([t, e]) => [e, t]));
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 6 * 1024 * 1024;

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, extra = {}) =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
const notFound = res => send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on("data", c => {
      if (over) return; // sisa data dibuang; koneksi ditutup setelah balasan terkirim (lihat tooBig)
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error("Ukuran data terlalu besar"), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Balas 413 lalu tutup koneksi supaya klien tidak terus mengirim data.
function tooBig(req, res, message) {
  res.on("finish", () => req.destroy());
  sendJson(res, 413, { error: message }, { Connection: "close" });
}

function sendFile(res, file, headers = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    send(res, 200, buf, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", ...headers });
  });
}

/* ---------- data ---------- */
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const int = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
// Foto: hanya path relatif "images/..." atau URL http(s).
const imgPath = v => {
  const s = str(v, 400);
  if (/^https?:\/\//i.test(s)) return s;
  return /^images\/[^\\]*$/.test(s) && !s.includes("..") ? s : "";
};
// Nomor WhatsApp: hanya angka, dan awalan 0 (mis. 0812…) diubah ke kode negara 62 karena wa.me butuh format internasional.
const waDigits = v => { const n = String(v ?? "").replace(/\D/g, "").slice(0, 20); return n.startsWith("0") ? "62" + n.slice(1) : n; };
const newId = () => crypto.randomBytes(5).toString("hex");

function clean(d) {
  d = d && typeof d === "object" ? d : {};
  const s = d.settings || {};
  const out = {
    settings: {
      title: str(s.title, 120) || "Katalog",
      subtitle: str(s.subtitle, 200),
      heroImage: imgPath(s.heroImage),
      waNumber: waDigits(s.waNumber),
    },
    categories: [], products: [],
    paket: { enabled: false, label: "Pembelian Paket", quickQty: [], addons: [] },
  };
  const uniq = (list, mk) => {
    const seen = new Set();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 1000)) {
      const item = mk(raw || {});
      if (!item) continue;
      while (seen.has(item.id)) item.id = newId();
      seen.add(item.id);
      mk.out.push(item);
    }
  };
  const idOf = v => str(v, 40).replace(/[^A-Za-z0-9_-]/g, "") || newId();

  const mkCat = c => { const name = str(c.name, 60); return name ? { id: idOf(c.id), name } : null; };
  mkCat.out = out.categories; uniq(d.categories, mkCat);
  const catIds = new Set(out.categories.map(c => c.id));

  const mkProd = p => {
    const name = str(p.name, 100);
    return name ? { id: idOf(p.id), name, price: int(p.price, 1e9), cat: catIds.has(p.cat) ? p.cat : "", img: imgPath(p.img), active: p.active !== false } : null;
  };
  mkProd.out = out.products; uniq(d.products, mkProd);

  const k = d.paket || {};
  out.paket.enabled = !!k.enabled;
  out.paket.label = str(k.label, 60) || "Pembelian Paket";
  out.paket.quickQty = [...new Set((Array.isArray(k.quickQty) ? k.quickQty : []).map(n => int(n, 9999)).filter(n => n >= 1))].slice(0, 12);
  const mkAddon = a => { const name = str(a.name, 60); return name ? { id: idOf(a.id), name, price: int(a.price, 1e9) } : null; };
  mkAddon.out = out.paket.addons; uniq((k.addons || []).slice(0, 20), mkAddon);
  return out;
}

const loadData = () => clean(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
function saveData(d) {
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Foto asli dicek dari byte awal file, bukan dari nama/ekstensi yang dikirim klien.
function sniff(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return ".png";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return ".gif";
  return null;
}

/* ---------- AI (opsional) ---------- */
// Konfigurasi dari env (AI_PROVIDER, AI_API_KEY, AI_MODEL, AI_BASE_URL) atau file ai.config.json
// {"provider","apiKey","model","baseUrl"}. File itu tidak pernah disajikan ke browser.
let aiMod = null;
let gpMod = null; // Google Photos (gphotos.mjs), dimuat saat pertama dipakai
async function aiConfig() {
  aiMod = aiMod || (await import("./ai-core.mjs"));
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, "ai.config.json"), "utf8")); } catch {}
  const map = { AI_PROVIDER: "provider", AI_API_KEY: "apiKey", AI_MODEL: "model", AI_BASE_URL: "baseUrl" };
  return aiMod.readConfig((k) => process.env[k] ?? file[map[k]] ?? "");
}
const aiHits = []; // pembatas laju sederhana: maks 20 permintaan AI per menit
function aiAllowed() {
  const now = Date.now();
  while (aiHits.length && now - aiHits[0] > 60000) aiHits.shift();
  if (aiHits.length >= 20) return false;
  aiHits.push(now); return true;
}

/* ---------- label AI foto Google Photos ---------- */
const LABEL_BATCH = 16;
function loadLabels() {
  try { return JSON.parse(fs.readFileSync(LABEL_FILE, "utf8")); } catch { return {}; }
}
// Sama seperti Edge Function: AI_API_KEY_PHOTO (+ AI_PROVIDER_PHOTO, AI_MODEL_PHOTO) bila ada, selain itu konfigurasi AI biasa.
async function photoAiConfig() {
  const cfg = await aiConfig();
  return process.env.AI_API_KEY_PHOTO ? aiMod.readConfig((k) => process.env[k + "_PHOTO"] || "") : cfg;
}
function loadRefs() {
  try { const r = JSON.parse(fs.readFileSync(REFS_FILE, "utf8")); return { names: r.names, sheets: r.sheets.map((data) => ({ type: "image/jpeg", data })) }; }
  catch { return null; }
}
function saveRefs(body) {
  const sheets = Array.isArray(body && body.sheets) ? body.sheets : [], names = (Array.isArray(body && body.names) ? body.names : []).slice(0, 2000).map((n) => String(n).slice(0, 100));
  if (!sheets.length || sheets.length > 8 || !names.length) return [400, { error: "Lembar contoh tidak valid" }];
  if (sheets.some((b) => { const buf = Buffer.from(String(b), "base64"); return buf.length > 1536 * 1024 || sniff(buf) !== ".jpg"; })) return [415, { error: "Lembar contoh harus JPEG (maks 1,5 MB)" }];
  fs.writeFileSync(REFS_FILE, JSON.stringify({ at: Date.now(), names, sheets }));
  return [200, { ok: true, count: sheets.length, products: names.length }];
}
function relabel(body) {
  const id = String((body && body.id) || ""), label = String((body && body.label) || "").trim().slice(0, 60);
  if (!gpMod.PHOTO_ID_RE.test(id) || !label) return [400, { error: "Label tidak valid" }];
  const prod = loadData().products.find((p) => aiMod.normName(p.name) === aiMod.normName(label));
  const all = loadLabels(), primary = prod ? prod.name : "";
  const a = ((all[id] && all[id].a) || []).filter((n) => n !== primary);
  all[id] = { l: prod ? prod.name : label, p: primary, ...(a.length ? { a } : {}), m: true };
  fs.writeFileSync(LABEL_FILE, JSON.stringify(all));
  return [200, { label: all[id] }];
}
// Foto dipasang ke produk: label foto = nama produk (dikunci); sama seperti attach() di Edge Function.
function attach(body) {
  const id = String((body && body.id) || "");
  if (!gpMod.PHOTO_ID_RE.test(id)) return [400, { error: "Foto tidak valid" }];
  const catalog = loadData().products;
  const names = [...new Set((Array.isArray(body && body.products) ? body.products : []).slice(0, 500)
    .map((n) => (catalog.find((p) => aiMod.normName(p.name) === aiMod.normName(n)) || {}).name).filter(Boolean))];
  if (!names.length) return [400, { error: "Produk tidak ditemukan" }];
  const all = loadLabels(), cur = all[id];
  const primary = cur && cur.m && cur.p ? cur.p : names[0];
  const a = [...new Set([...(cur && cur.m ? cur.a || [] : []), ...names])].filter((n) => n !== primary);
  all[id] = { l: primary, p: primary, ...(a.length ? { a } : {}), m: true };
  fs.writeFileSync(LABEL_FILE, JSON.stringify(all));
  return [200, { label: all[id] }];
}
async function labelBatch(items) {
  const cfg = await photoAiConfig();
  if (!cfg) throw new aiMod.AiError(503, "Fitur AI belum dikonfigurasi (AI_API_KEY belum diisi).", "ai_not_configured");
  const manual = loadLabels();
  items = items.filter((it) => !(manual[it.id] && manual[it.id].m)); // koreksi admin tidak ditimpa AI
  if (!items.length) return {};
  // Foto diambil kecil (256 px) supaya hemat kuota AI; foto yang gagal diambil dilewati.
  const got = (await Promise.all(items.map(async (it) => {
    try {
      const f = await gpMod.fetchPhoto(it.src, 256), ext = sniff(Buffer.from(f.bytes));
      return { id: it.id, image: { type: ext ? EXT_TYPES[ext] : "image/jpeg", data: aiMod.toBase64(f.bytes) } };
    } catch { return null; }
  }))).filter(Boolean);
  const res = await aiMod.labelPhotos(got.map((g) => g.image), loadData(), cfg, { refs: loadRefs() });
  const out = {}, all = loadLabels();
  res.forEach((r, i) => { if (r) out[got[i].id] = all[got[i].id] = { l: r.label, p: r.product }; });
  fs.writeFileSync(LABEL_FILE, JSON.stringify(all));
  return out;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const method = req.method;

    // ===== Publik (hanya baca) =====
    if (method === "GET" || method === "HEAD") {
      if (p === "/" || p === "/index.html") return sendFile(res, path.join(ROOT, "index.html"), { "Cache-Control": "no-cache" });
      // Kasir + cek harga dengan kamera (hanya membaca /api/data; data kasir disimpan di HP masing-masing)
      if (p === "/kasir") { res.writeHead(301, { Location: "/kasir/" }); return res.end(); }
      if (p === "/kasir/") return sendFile(res, path.join(ROOT, "kasir.html"), { "Cache-Control": "no-cache", "X-Robots-Tag": "noindex, nofollow" });
      if (p === "/kasir/manifest.webmanifest") return sendFile(res, path.join(ROOT, "kasir.webmanifest"), { "Cache-Control": "no-cache" });
      if (p === "/api/data") {
        const d = loadData();
        d.products = d.products.filter(x => x.active);
        return sendJson(res, 200, d);
      }
      if (p.startsWith("/images/")) {
        const f = path.resolve(IMG_DIR, "." + p.slice("/images".length));
        if (!f.startsWith(IMG_DIR + path.sep)) return notFound(res);
        return sendFile(res, f, { "Cache-Control": "public, max-age=3600" });
      }
      // PWA (pasang di HP): manifest, service worker, ikon
      if (p === "/manifest.webmanifest" || p === "/sw.js") return sendFile(res, path.join(ROOT, p.slice(1)), { "Cache-Control": "no-cache" });
      if (p.startsWith("/icons/")) {
        const f = path.resolve(ICON_DIR, "." + p.slice("/icons".length));
        if (!f.startsWith(ICON_DIR + path.sep)) return notFound(res);
        return sendFile(res, f, { "Cache-Control": "public, max-age=86400" });
      }
    }

    // ===== Admin (link rahasia) =====
    if (p === A) { res.writeHead(301, { Location: A + "/" }); return res.end(); }
    if (p === A + "/" || p === A + "/manifest.webmanifest" || p.startsWith(A + "/api/")) {
      const adminHeaders = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
      if (p === A + "/" && method === "GET") return sendFile(res, path.join(ROOT, "admin.html"), adminHeaders);
      if (p === A + "/manifest.webmanifest" && method === "GET") { // aplikasi admin terpisah di HP; alamatnya mengikuti link admin
        const m = fs.readFileSync(path.join(ROOT, "admin.webmanifest"), "utf8").replaceAll("__ADMIN__", ADMIN);
        return send(res, 200, m, { "Content-Type": "application/manifest+json", ...adminHeaders });
      }

      if (p === A + "/api/data" && method === "GET") return sendJson(res, 200, loadData(), adminHeaders);
      if (p === A + "/api/data" && method === "PUT") {
        let body;
        try { body = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8")); }
        catch (e) { return e.status === 413 ? tooBig(req, res, "Data terlalu besar") : sendJson(res, 400, { error: "Data tidak valid" }); }
        const d = clean(body);
        saveData(d);
        return sendJson(res, 200, d, adminHeaders);
      }
      if (p === A + "/api/ai" && method === "POST") {
        let body;
        try { body = JSON.parse((await readBody(req, 300 * 1024)).toString("utf8")); }
        catch (e) { return e.status === 413 ? tooBig(req, res, "Pesan terlalu besar") : sendJson(res, 400, { error: "Data tidak valid" }); }
        if (!aiAllowed()) return sendJson(res, 429, { error: "Terlalu banyak permintaan AI. Tunggu sebentar.", code: "ai_rate" });
        try {
          const cfg = await aiConfig();
          return sendJson(res, 200, await aiMod.handleAi(body, cfg));
        } catch (e) {
          if (e && e.code && e.status) return sendJson(res, e.status, { error: e.message, code: e.code });
          console.error("AI error:", e && e.message);
          return sendJson(res, 500, { error: "Terjadi kesalahan pada fitur AI", code: "ai_error" });
        }
      }
      if (p === A + "/api/upload" && method === "POST") {
        const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!UPLOAD_TYPES[type]) return sendJson(res, 415, { error: "Hanya foto JPG, PNG, WEBP atau GIF" });
        let buf;
        try { buf = await readBody(req, MAX_UPLOAD); }
        catch (e) { return e.status === 413 ? tooBig(req, res, "Foto terlalu besar (maks 6 MB)") : sendJson(res, 400, { error: "Upload gagal" }); }
        const ext = sniff(buf);
        if (!ext) return sendJson(res, 415, { error: "Isi file bukan foto yang valid" });
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
        return sendJson(res, 200, { path: "images/uploads/" + name });
      }
      if ([A + "/api/gphotos", A + "/api/gphotos-import", A + "/api/gphotos-label", A + "/api/gphotos-refs", A + "/api/gphotos-relabel", A + "/api/gphotos-attach"].includes(p) && method === "POST") {
        let body;
        try { body = JSON.parse((await readBody(req, p.endsWith("/gphotos-refs") ? 12 * 1024 * 1024 : 16384)).toString("utf8")); }
        catch (e) { return e.status === 413 ? tooBig(req, res, "Data terlalu besar") : sendJson(res, 400, { error: "Data tidak valid" }); }
        gpMod = gpMod || (await import("./gphotos.mjs"));
        try {
          if (p === A + "/api/gphotos") {
            const album = await gpMod.listAlbum(body && body.link), all = loadLabels();
            const labels = Object.fromEntries(album.photos.filter((x) => all[x.id]).map((x) => [x.id, all[x.id]]));
            return sendJson(res, 200, { ...album, labels }, adminHeaders);
          }
          if (p === A + "/api/gphotos-refs") { const [st, out] = saveRefs(body); return sendJson(res, st, out, adminHeaders); }
          if (p === A + "/api/gphotos-relabel") { aiMod = aiMod || (await import("./ai-core.mjs")); const [st, out] = relabel(body); return sendJson(res, st, out, adminHeaders); }
          if (p === A + "/api/gphotos-attach") { aiMod = aiMod || (await import("./ai-core.mjs")); const [st, out] = attach(body); return sendJson(res, st, out, adminHeaders); }
          if (p === A + "/api/gphotos-label") {
            const items = (body && Array.isArray(body.items) ? body.items : []).slice(0, LABEL_BATCH)
              .filter((it) => it && gpMod.PHOTO_ID_RE.test(String(it.id)) && typeof it.src === "string");
            if (!items.length) return sendJson(res, 400, { error: "Tidak ada foto untuk dikenali" });
            if (!aiAllowed()) return sendJson(res, 429, { error: "Terlalu banyak permintaan AI. Tunggu sebentar.", code: "ai_rate" });
            return sendJson(res, 200, { labels: await labelBatch(items) }, adminHeaders);
          }
          const buf = Buffer.from((await gpMod.fetchPhoto(body && body.src)).bytes);
          if (buf.length > MAX_UPLOAD) return sendJson(res, 413, { error: "Foto terlalu besar (maks 6 MB)" });
          const ext = sniff(buf);
          if (!ext) return sendJson(res, 415, { error: "Isi file bukan foto yang valid" });
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}${ext}`;
          fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
          return sendJson(res, 200, { path: "images/uploads/" + name });
        } catch (e) {
          if (e instanceof gpMod.GPhotosError) return sendJson(res, e.status, { error: e.message });
          if (e && e.code && e.status) return sendJson(res, e.status, { error: e.message, code: e.code }); // AiError
          throw e;
        }
      }
    }

    notFound(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, e instanceof URIError ? 400 : 500, { error: "Terjadi kesalahan" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Website : http://localhost:${PORT}/`);
  console.log(`Admin   : http://localhost:${PORT}${A}/`);
  if (ADMIN === "adminxx") console.warn('PERINGATAN: adminPath masih "adminxx" (mudah ditebak). Ganti di config.json, lalu restart.');
});
