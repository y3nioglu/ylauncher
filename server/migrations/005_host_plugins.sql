-- Faz 7: plugin senkronizasyonu.
-- Host, plugins/ klasorundeki .jar'larin manifest'ini (sha256 + boyut) burada
-- yayinlar; jar dosyalari API sunucusunun diskine yüklenir ve arkadas
-- launcher'lari Katil'dan once eksik/farkli jar'lari buradan indirir.
-- Politika: host basina TEK aktif plugin seti (joinable sunucu basina bir set),
-- dosya basina bir satir. Publish tamamlaninca eski set degistirilir.
create table if not exists public.ylauncher_host_plugins (
  host_id     int         not null references public.ylauncher_users(id) on delete cascade,
  filename    text        not null,
  sha256      text        not null,
  size_bytes  bigint      not null,
  published_at timestamptz not null default now(),
  primary key (host_id, filename)
);

create index if not exists ylauncher_host_plugins_host_idx
  on public.ylauncher_host_plugins (host_id);
