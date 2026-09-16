-- Faz 14: sunucu duyurusuna icerik meta verisi (rozetler icin).
-- Host'un duyurusuna ekledigi sayilar; arkadaslarin sunucu listesinde
-- "🧩 N mod" / "🔌 N plugin" rozetleri olarak gosterilir.
alter table public.ylauncher_servers
  add column if not exists client_mods int not null default 0,
  add column if not exists plugins     int not null default 0;
