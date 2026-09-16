-- Faz 12: client mod senkronizasyonu.
-- Host, clientMods/ klasorune koydugu istemci modlarini (Sodium, minimap vb.)
-- ayni plugin senkronu deseniyle arkadaslara dagitir; ayrica sunucunun MC
-- surumu icin secilen Fabric loader profilini yayinlar. Katilan taraf Katil
-- akisinda eksik modlari indirir ve gerekirse Fabric profilini kurar.
create table if not exists public.ylauncher_host_clientmods (
  host_id     int         not null references public.ylauncher_users(id) on delete cascade,
  filename    text        not null,
  sha256      text        not null,
  size_bytes  bigint      not null,
  published_at timestamptz not null default now(),
  primary key (host_id, filename)
);

create index if not exists ylauncher_host_clientmods_host_idx
  on public.ylauncher_host_clientmods (host_id);

create table if not exists public.ylauncher_host_profiles (
  host_id     int primary key references public.ylauncher_users(id) on delete cascade,
  loader      text        not null, -- 'fabric' | 'vanilla' (ileride 'forge')
  loader_version text     not null,
  mc_version  text        not null,
  published_at timestamptz not null default now()
);
