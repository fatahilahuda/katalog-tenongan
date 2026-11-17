// Admin: /adminxx/api/* -> fungsi admin (link admin ikut diperiksa oleh fungsi)
export async function onRequest({ request, params }) {
  const path = [].concat(params.path || []).map(encodeURIComponent).join("/");
  const init = { method: request.method, headers: { "Content-Type": request.headers.get("Content-Type") || "application/octet-stream" } };
  if (!["GET", "HEAD"].includes(request.method)) init.body = await request.arrayBuffer();
  const r = await fetch("https://nyvwnpkhzkdtmbwigfoy.supabase.co/functions/v1/catalog/a/adminxx/" + path, init);
  return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
