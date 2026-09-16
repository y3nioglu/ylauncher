-- Faz 5a: aktif sunucu duyurulari
-- Her host tek satir (host_id primary key): son duyuru bilgisi.
-- Eskiyen kayitlar listelenmez (announced_at + host'un last_seen_at penceresiyle).
create table if not exists public.ylauncher_servers (
  host_id      int         not null references public.ylauncher_users(id) on delete cascade,
  address      text        not null,
  port         int         not null default 25565,
  mc_version   text        not null,
  announced_at timestamptz not null default now(),
  primary key (host_id)
);

create index if not exists ylauncher_servers_announced_idx
  on public.ylauncher_servers (announced_at);
