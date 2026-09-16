-- Faz 5c: whitelist'e ekleme istekleri.
-- Katilamayan arkadas (whitelist kick yedi) launcher'dan istek gonderir;
-- host bildirim panelinden tek tikla hem API'yi onaylar hem de lokal
-- whitelist'e ekler. Gecmis korunur (accepted/declined) — UI sonucu gosterir.
create table if not exists public.ylauncher_whitelist_requests (
  id           int generated always as identity primary key,
  host_id      int         not null references public.ylauncher_users(id) on delete cascade,
  requester_id int         not null references public.ylauncher_users(id) on delete cascade,
  status       text        not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  unique (host_id, requester_id)
);

create index if not exists ylauncher_wlreq_host_idx
  on public.ylauncher_whitelist_requests (host_id, status);
create index if not exists ylauncher_wlreq_requester_idx
  on public.ylauncher_whitelist_requests (requester_id, status);
