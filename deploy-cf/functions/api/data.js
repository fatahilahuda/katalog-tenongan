// Pengunjung: data katalog publik (hanya produk aktif)
export const onRequestGet = () => fetch("https://nyvwnpkhzkdtmbwigfoy.supabase.co/functions/v1/catalog/public").then((r) =>
  new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }));
