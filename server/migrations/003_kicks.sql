-- Faz 5b: host tarafinda yakalanan kick sebepleri.
-- Minecraft kick sebebini client log'una her zaman yazmaz (canlida yasandi:
-- whitelist kick'i client'a sadece "Connection reset" olarak ulasti), ama
-- HOST'un Paper log'una her zaman yazilir. Host yakalar, API uzerinden
-- kisa omurlu olarak tasiyiciya ulastirir.
create table if not exists public.ylauncher_server_kicks (
  host_id     int         not null references public.ylauncher_users(id) on delete cascade,
  nickname_ci text        not null,          -- lower(nickname)
  reason      text        not null,          -- Turkce, kullaniciya donen sebep
  raw_line    text        not null,          -- hata ayiklama icin ham log satiri
  created_at  timestamptz not null default now(),
  primary key (host_id, nickname_ci)
);

create index if not exists ylauncher_server_kicks_created_idx
  on public.ylauncher_server_kicks (created_at);
