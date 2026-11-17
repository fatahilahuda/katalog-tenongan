-- Label AI untuk foto album Google Photos (dipakai pemilih foto di admin: cari & kelompokkan).
-- Hanya diakses Edge Function "catalog" lewat service role; RLS aktif tanpa kebijakan = tertutup untuk publik.
create table if not exists public.katalog_photo_labels (
  id text primary key,                 -- id foto Google Photos (AF1Qip...)
  label text not null,                 -- nama makanan menurut AI
  product text not null default '',    -- nama produk katalog yang cocok ('' bila tidak ada)
  updated_at timestamptz not null default now()
);
alter table public.katalog_photo_labels enable row level security;

-- Label yang dikoreksi admin (manual = true) tidak ditimpa saat foto dikenali ulang oleh AI.
alter table public.katalog_photo_labels add column if not exists manual boolean not null default false;

-- Foto yang dipasang ke beberapa produk: produk utama di kolom product, produk lainnya di sini.
alter table public.katalog_photo_labels add column if not exists also_products text[] not null default '{}';
