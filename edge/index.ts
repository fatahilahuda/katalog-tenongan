// Edge Function "catalog": backend katalog (port dari server.js lokal).
//   GET  /catalog/public                    -> data katalog untuk pengunjung (hanya produk aktif)
//   GET  /catalog/a/<link-admin>/data       -> data lengkap untuk admin
//   PUT  /catalog/a/<link-admin>/data       -> simpan data dari admin
//   POST /catalog/a/<link-admin>/upload     -> unggah foto ke Storage (bucket "katalog")
//   POST /catalog/a/<link-admin>/gphotos   -> daftar foto album Google Photos ({ link }; lihat gphotos.mjs)
//   POST /catalog/a/<link-admin>/gphotos-import -> salin satu foto Google Photos ke Storage ({ src })
//   POST /catalog/a/<link-admin>/gphotos-label  -> kenali foto dengan AI ({ items: [{ id, src }] }, maks 16; secret AI_API_KEY_PHOTO; tabel katalog_photo_labels)
//   POST /catalog/a/<link-admin>/gphotos-refs   -> simpan lembar contoh foto produk untuk AI ({ sheets: [base64 JPEG], names }; Storage refs/)
//   POST /catalog/a/<link-admin>/gphotos-relabel -> koreksi label satu foto oleh admin ({ id, label }); tidak ditimpa AI lagi
//   POST /catalog/a/<link-admin>/gphotos-attach  -> foto dipasang ke produk: label foto = nama produk itu ({ id, products: [nama] })
//   POST /catalog/a/<link-admin>/ai         -> asisten AI (butuh secret AI_API_KEY; lihat ai-core.mjs)
// Tanpa login: satu-satunya "kunci" adalah link admin (tersimpan di tabel katalog_config), sama seperti versi lokal.
// Tabel dilindungi RLS tanpa kebijakan publik; fungsi ini memakai service role.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AiError, handleAi, labelPhotos, normName, readConfig, toBase64 } from "./ai-core.mjs";
import { fetchPhoto, GPhotosError, listAlbum, PHOTO_ID_RE } from "./gphotos.mjs";

const BASE = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
};
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...CORS, ...extra },
  });

const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 6 * 1024 * 1024;
const UPLOAD_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const EXT_TYPES: Record<string, string> = Object.fromEntries(Object.entries(UPLOAD_TYPES).map(([t, e]) => [e, t]));

/* ---------- validasi data (sama dengan server.js) ---------- */
const str = (v: any, max: number) => String(v ?? "").trim().slice(0, max);
const int = (v: any, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
const imgPath = (v: any) => {
  const s = str(v, 400);
  if (/^https?:\/\//i.test(s)) return s;
  return /^images\/[^\\]*$/.test(s) && !s.includes("..") ? s : "";
};
const waDigits = (v: any) => { const n = String(v ?? "").replace(/\D/g, "").slice(0, 20); return n.startsWith("0") ? "62" + n.slice(1) : n; };
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

function clean(d: any): any {
  d = d && typeof d === "object" ? d : {};
  const s = d.settings || {};
  const out: any = {
    settings: { title: str(s.title, 120) || "Katalog", subtitle: str(s.subtitle, 200), heroImage: imgPath(s.heroImage), waNumber: waDigits(s.waNumber) },
    categories: [], products: [],
    paket: { enabled: false, label: "Pembelian Paket", quickQty: [], addons: [] },
  };
  const idOf = (v: any) => str(v, 40).replace(/[^A-Za-z0-9_-]/g, "") || newId();
  const uniq = (list: any, mk: (x: any) => any, target: any[]) => {
    const seen = new Set<string>();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 1000)) {
      const item = mk(raw || {});
      if (!item) continue;
      while (seen.has(item.id)) item.id = newId();
      seen.add(item.id);
      target.push(item);
    }
  };
  uniq(d.categories, (c) => { const name = str(c.name, 60); return name ? { id: idOf(c.id), name } : null; }, out.categories);
  const catIds = new Set(out.categories.map((c: any) => c.id));
  uniq(d.products, (p) => {
    const name = str(p.name, 100);
    return name ? { id: idOf(p.id), name, price: int(p.price, 1e9), cat: catIds.has(p.cat) ? p.cat : "", img: imgPath(p.img), active: p.active !== false } : null;
  }, out.products);
  const k = d.paket || {};
  out.paket.enabled = !!k.enabled;
  out.paket.label = str(k.label, 60) || "Pembelian Paket";
  out.paket.quickQty = [...new Set((Array.isArray(k.quickQty) ? k.quickQty : []).map((n: any) => int(n, 9999)).filter((n: number) => n >= 1))].slice(0, 12);
  uniq((Array.isArray(k.addons) ? k.addons : []).slice(0, 20), (a) => { const name = str(a.name, 60); return name ? { id: idOf(a.id), name, price: int(a.price, 1e9) } : null; }, out.paket.addons);
  return out;
}

/* ---------- penyimpanan ---------- */
async function load() {
  const { data, error } = await sb.from("katalog_data").select("data").eq("id", 1).maybeSingle();
  if (error) throw error;
  return clean(data?.data ?? {});
}
async function save(d: any) {
  const { data: cur } = await sb.from("katalog_data").select("data").eq("id", 1).maybeSingle();
  if (cur?.data) {
    await sb.from("katalog_history").insert({ data: cur.data });
    const { data: old } = await sb.from("katalog_history").select("id").order("id", { ascending: false }).range(30, 2000); // simpan 30 terakhir
    if (old?.length) await sb.from("katalog_history").delete().in("id", old.map((r: any) => r.id));
  }
  const { error } = await sb.from("katalog_data").upsert({ id: 1, data: d, updated_at: new Date().toISOString() });
  if (error) throw error;
}
const aiHits: number[] = []; // pembatas laju sederhana per instance: maks 20 permintaan AI per menit
function aiAllowed() {
  const now = Date.now();
  while (aiHits.length && now - aiHits[0] > 60000) aiHits.shift();
  if (aiHits.length >= 20) return false;
  aiHits.push(now); return true;
}
// Konfigurasi AI dari secret Edge Function: AI_API_KEY (+ AI_PROVIDER, AI_MODEL) untuk asisten ✨ AI.
// Pengenalan foto memakai AI_API_KEY_PHOTO (+ AI_PROVIDER_PHOTO, AI_MODEL_PHOTO; bawaan Gemini) bila diisi,
// supaya bisa memakai key/penyedia yang mendukung gambar tanpa mengganggu asisten; bila kosong ikut AI_API_KEY.
const env = (k: string) => Deno.env.get(k) || "";
const aiConfig = () => readConfig(env);
const photoAiConfig = () => env("AI_API_KEY_PHOTO") ? readConfig((k: string) => env(k + "_PHOTO")) : aiConfig();
async function adminPath(): Promise<string> {
  const { data } = await sb.from("katalog_config").select("value").eq("key", "admin_path").maybeSingle();
  return data?.value ?? "";
}

// Jenis foto dicek dari byte awal file, bukan dari header/ekstensi kiriman klien.
function sniff(b: Uint8Array): string | null {
  const a = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (b.length > 8 && b[0] === 0x89 && a(1, "PNG")) return ".png";
  if (b.length > 12 && a(0, "RIFF") && a(8, "WEBP")) return ".webp";
  if (b.length > 6 && a(0, "GIF8")) return ".gif";
  return null;
}

/* ---------- label AI foto Google Photos ---------- */
const LABEL_BATCH = 16;
// l = label, p = produk utama, a = produk lain yang juga memakai foto ini, m = dikoreksi/dipasang admin (tidak ditimpa AI)
type PhotoLabel = { l: string; p: string; a?: string[]; m?: boolean };
const labelOf = (r: any): PhotoLabel => {
  const o: PhotoLabel = { l: r.label, p: r.product };
  if (r.also_products?.length) o.a = r.also_products;
  if (r.manual) o.m = true;
  return o;
};
// Semua label tersimpan (id -> label). Bila tabel belum dibuat, anggap belum ada label.
async function loadLabels(): Promise<Record<string, PhotoLabel>> {
  const { data, error } = await sb.from("katalog_photo_labels").select("id,label,product,manual,also_products").limit(50000);
  if (error) { console.error("katalog_photo_labels:", error.message); return {}; }
  return Object.fromEntries((data || []).map((r: any) => [r.id, labelOf(r)]));
}

// Lembar contoh: kolase foto produk katalog bernomor (C1, C2, ...) yang dibuat halaman admin, disimpan di Storage refs/.
// Dikirim ke AI bersama foto yang dikenali supaya AI tahu tampilan produk toko ini sendiri.
// Daftar kode -> nama produk disimpan di katalog_config (key photo_refs), karena bucket hanya menerima file gambar.
const REFS_MAX = 8, SHEET_MAX = 1536 * 1024;
let refsCache: { at: number; sheets: { type: string; data: string }[]; names: string[] } | null = null;
async function loadRefs() {
  const { data: row } = await sb.from("katalog_config").select("value").eq("key", "photo_refs").maybeSingle();
  if (!row?.value) return null;
  const meta = JSON.parse(row.value);
  if (refsCache && refsCache.at === meta.at) return refsCache;
  const sheets: { type: string; data: string }[] = [];
  for (let i = 0; i < meta.count; i++) {
    const { data } = await sb.storage.from("katalog").download(`refs/sheet-${i + 1}.jpg`);
    if (!data) return null;
    sheets.push({ type: "image/jpeg", data: toBase64(new Uint8Array(await data.arrayBuffer())) });
  }
  return (refsCache = { at: meta.at, sheets, names: meta.names });
}
async function saveRefs(body: any): Promise<Response> {
  const sheets = Array.isArray(body?.sheets) ? body.sheets.slice(0, REFS_MAX + 1) : [];
  const names = (Array.isArray(body?.names) ? body.names : []).slice(0, 2000).map((n: any) => str(n, 100));
  if (!sheets.length || sheets.length > REFS_MAX || !names.length) return json({ error: "Lembar contoh tidak valid" }, 400);
  const bufs = sheets.map((b64: any) => { try { return Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0)); } catch { return null; } });
  if (bufs.some((b: any) => !b || b.length > SHEET_MAX || sniff(b) !== ".jpg")) return json({ error: "Lembar contoh harus JPEG (maks 1,5 MB)" }, 415);
  for (let i = 0; i < bufs.length; i++) {
    const { error } = await sb.storage.from("katalog").upload(`refs/sheet-${i + 1}.jpg`, bufs[i], { contentType: "image/jpeg", upsert: true });
    if (error) return json({ error: "Gagal menyimpan lembar contoh" }, 500);
  }
  const meta = { at: Date.now(), count: bufs.length, names };
  const { error } = await sb.from("katalog_config").upsert({ key: "photo_refs", value: JSON.stringify(meta) });
  if (error) return json({ error: "Gagal menyimpan lembar contoh" }, 500);
  return json({ ok: true, count: bufs.length, products: names.length });
}

async function labelBatch(items: any[]): Promise<Record<string, PhotoLabel>> {
  const cfg = photoAiConfig();
  if (!cfg) throw new AiError(503, "Fitur AI belum dikonfigurasi (AI_API_KEY_PHOTO / AI_API_KEY belum diisi).", "ai_not_configured");
  // Label yang sudah dikoreksi admin tidak dikirim ke AI.
  const { data: manual } = await sb.from("katalog_photo_labels").select("id").eq("manual", true).in("id", items.map((it) => it.id));
  const skip = new Set((manual || []).map((r: any) => r.id));
  items = items.filter((it) => !skip.has(it.id));
  if (!items.length) return {};
  // Foto diambil kecil (256 px) supaya hemat kuota AI; foto yang gagal diambil dilewati.
  const got = (await Promise.all(items.map(async (it) => {
    try { const f = await fetchPhoto(it.src, 256); return { id: it.id, image: { type: EXT_TYPES[sniff(f.bytes) || ""] || "image/jpeg", data: toBase64(f.bytes) } }; }
    catch { return null; }
  }))).filter((x): x is { id: string; image: { type: string; data: string } } => !!x);
  const refs = await loadRefs().catch((e) => { console.error("lembar contoh:", e?.message); return null; });
  const res = await labelPhotos(got.map((g) => g.image), await load(), cfg, { refs });
  const out: Record<string, PhotoLabel> = {}, rows: any[] = [];
  res.forEach((r: any, i: number) => {
    if (!r) return;
    out[got[i].id] = { l: r.label, p: r.product };
    rows.push({ id: got[i].id, label: r.label, product: r.product, manual: false, updated_at: new Date().toISOString() });
  });
  if (rows.length) {
    const { error } = await sb.from("katalog_photo_labels").upsert(rows);
    if (error) console.error("simpan label:", error.message);
  }
  return out;
}
async function labelRow(id: string) {
  const { data } = await sb.from("katalog_photo_labels").select("label,product,manual,also_products").eq("id", id).maybeSingle();
  return data;
}
// Koreksi admin: label bebas; bila sama dengan nama produk katalog (abaikan huruf besar/kecil & tanda baca) dicocokkan ke produk itu.
async function relabel(body: any): Promise<Response> {
  const id = String(body?.id || ""), label = str(body?.label, 60);
  if (!PHOTO_ID_RE.test(id) || !label) return json({ error: "Label tidak valid" }, 400);
  const prod = (await load()).products.find((p: any) => normName(p.name) === normName(label));
  const primary = prod ? prod.name : "", cur = await labelRow(id);
  const row = { id, label: prod ? prod.name : label, product: primary, also_products: (cur?.also_products || []).filter((n: string) => n !== primary),
    manual: true, updated_at: new Date().toISOString() };
  const { error } = await sb.from("katalog_photo_labels").upsert(row);
  if (error) return json({ error: "Gagal menyimpan label" }, 500);
  return json({ label: labelOf(row) });
}
// Foto album dipasang ke produk: foto itu diberi label nama produk (dikunci) supaya jadi saran di produk tersebut.
// Produk utama dari koreksi admin sebelumnya dipertahankan; produk lain ditambahkan ke also_products.
async function attach(body: any): Promise<Response> {
  const id = String(body?.id || "");
  if (!PHOTO_ID_RE.test(id)) return json({ error: "Foto tidak valid" }, 400);
  const catalog = (await load()).products;
  const names = [...new Set((Array.isArray(body?.products) ? body.products : []).slice(0, 500)
    .map((n: any) => catalog.find((p: any) => normName(p.name) === normName(n))?.name).filter(Boolean))] as string[];
  if (!names.length) return json({ error: "Produk tidak ditemukan" }, 400);
  const cur = await labelRow(id);
  const primary = cur?.manual && cur.product ? cur.product : names[0];
  const also = [...new Set([...(cur?.manual ? cur.also_products || [] : []), ...names])].filter((n) => n !== primary);
  const row = { id, label: primary, product: primary, also_products: also, manual: true, updated_at: new Date().toISOString() };
  const { error } = await sb.from("katalog_photo_labels").upsert(row);
  if (error) return json({ error: "Gagal menyimpan label" }, 500);
  return json({ label: labelOf(row) });
}

// Simpan foto ke Storage; jenis file ditentukan dari isinya.
async function store(buf: Uint8Array): Promise<Response> {
  if (buf.length > MAX_UPLOAD) return json({ error: "Foto terlalu besar (maks 6 MB)" }, 413);
  const ext = sniff(buf);
  if (!ext) return json({ error: "Isi file bukan foto yang valid" }, 415);
  const name = `uploads/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const { error } = await sb.storage.from("katalog").upload(name, buf, { contentType: EXT_TYPES[ext], upsert: false });
  if (error) return json({ error: "Upload gagal" }, 500);
  return json({ path: `${BASE}/storage/v1/object/public/katalog/${name}` });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const url = new URL(req.url);
    const i = url.pathname.indexOf("/catalog");
    const parts = url.pathname.slice(i + "/catalog".length).split("/").filter(Boolean).map(decodeURIComponent);

    // Publik (hanya baca)
    if (parts.length === 1 && parts[0] === "public" && req.method === "GET") {
      const d = await load();
      d.products = d.products.filter((p: any) => p.active);
      return json(d);
    }

    // Admin: /a/<link-admin>/(data|upload)
    if (parts[0] === "a" && parts.length === 3) {
      const path = await adminPath();
      if (!path || parts[1] !== path) return json({ error: "Not found" }, 404);

      if (parts[2] === "data" && req.method === "GET") return json(await load());
      if (parts[2] === "data" && req.method === "PUT") {
        const text = await req.text();
        if (text.length > MAX_JSON) return json({ error: "Data terlalu besar" }, 413);
        let body: any;
        try { body = JSON.parse(text); } catch { return json({ error: "Data tidak valid" }, 400); }
        const d = clean(body);
        await save(d);
        return json(d);
      }
      if (parts[2] === "ai" && req.method === "POST") {
        const text = await req.text();
        if (text.length > 300 * 1024) return json({ error: "Pesan terlalu besar" }, 413);
        let body: any;
        try { body = JSON.parse(text); } catch { return json({ error: "Data tidak valid" }, 400); }
        if (!aiAllowed()) return json({ error: "Terlalu banyak permintaan AI. Tunggu sebentar.", code: "ai_rate" }, 429);
        try {
          const cfg = aiConfig();
          return json(await handleAi(body, cfg));
        } catch (e) {
          if (e instanceof AiError) return json({ error: e.message, code: e.code }, e.status);
          console.error("AI error:", (e as Error)?.message);
          return json({ error: "Terjadi kesalahan pada fitur AI", code: "ai_error" }, 500);
        }
      }
      if (parts[2] === "upload" && req.method === "POST") {
        const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!UPLOAD_TYPES[type]) return json({ error: "Hanya foto JPG, PNG, WEBP atau GIF" }, 415);
        return await store(new Uint8Array(await req.arrayBuffer()));
      }
      if (["gphotos", "gphotos-import", "gphotos-label", "gphotos-refs", "gphotos-relabel", "gphotos-attach"].includes(parts[2]) && req.method === "POST") {
        const text = await req.text();
        if (text.length > (parts[2] === "gphotos-refs" ? 12 * 1024 * 1024 : 16384)) return json({ error: "Data terlalu besar" }, 413);
        let body: any;
        try { body = JSON.parse(text); } catch { return json({ error: "Data tidak valid" }, 400); }
        try {
          if (parts[2] === "gphotos") {
            const [album, labels] = await Promise.all([listAlbum(body?.link), loadLabels()]);
            return json({ ...album, labels: Object.fromEntries(album.photos.filter((p: any) => labels[p.id]).map((p: any) => [p.id, labels[p.id]])) });
          }
          if (parts[2] === "gphotos-import") return await store((await fetchPhoto(body?.src)).bytes);
          if (parts[2] === "gphotos-refs") return await saveRefs(body);
          if (parts[2] === "gphotos-relabel") return await relabel(body);
          if (parts[2] === "gphotos-attach") return await attach(body);
          const items = (Array.isArray(body?.items) ? body.items : []).slice(0, LABEL_BATCH)
            .filter((it: any) => PHOTO_ID_RE.test(String(it?.id)) && typeof it?.src === "string");
          if (!items.length) return json({ error: "Tidak ada foto untuk dikenali" }, 400);
          if (!aiAllowed()) return json({ error: "Terlalu banyak permintaan AI. Tunggu sebentar.", code: "ai_rate" }, 429);
          return json({ labels: await labelBatch(items) });
        } catch (e) {
          if (e instanceof GPhotosError) return json({ error: e.message }, e.status);
          if (e instanceof AiError) return json({ error: e.message, code: e.code }, e.status);
          throw e;
        }
      }
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Terjadi kesalahan" }, 500);
  }
});
