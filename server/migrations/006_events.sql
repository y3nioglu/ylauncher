-- Faz 9: anlik bildirim altyapisi (SSE push).
-- Mimarisi: uygulamalar degisiklik yaptiginda trigger'lar ylauncher_events'e
-- "kime bir sey degisti" satirlari yazar; GET /api/events/stream bu tabloyu
-- kisa long-poll dongusuyle izler. Kullanici "neler degisti?" sormak yerine
-- "bana bir sey degisti mi?" diye bekler — gecikme sn'ler yerine ms olur ve
-- bos beklemeler API/DB yukunu artirmaz.
create table if not exists public.ylauncher_events (
  id         bigserial primary key,
  user_id    integer      not null references public.ylauncher_users(id) on delete cascade,
  kind       text         not null,
  created_at timestamptz  not null default now()
);
create index if not exists ylauncher_events_user_id_id_idx
  on public.ylauncher_events (user_id, id);

-- Purge: her kullanici icin yalnizca en yeni olaylari tut (list 200'u asan
-- eski satirlar silinir). Baglanti kurmadan once de guncel durumu ceken
-- istemci zaten tam listeleri aldigi icin backlog yalnizca emniyet netidir.
create or replace function public.ylauncher_purge_user_events() returns trigger as $$
begin
  delete from public.ylauncher_events e
  where e.user_id = new.user_id
    and e.id < (
      select coalesce(max(id), 0) - 199
      from public.ylauncher_events where user_id = new.user_id
    );
  return null;
end;
$$ language plpgsql;

drop trigger if exists ylauncher_purge_user_events_trg on public.ylauncher_events;
create trigger ylauncher_purge_user_events_trg
  after insert on public.ylauncher_events
  for each row execute function public.ylauncher_purge_user_events();

-- Yardimci: tablo okunmasi yerine trigger tarafindan yazilan olaylar
-- NOT: parametre bigint olmali — trigger'lar bigint kolonlari (id'ler) geciyor;
-- integer imzayla Postgres fonksiyon cozumlemesi basarisiz olur (42883).
create or replace function public.ylauncher_notify(uid bigint, k text) returns void as $$
begin
  insert into public.ylauncher_events (user_id, kind) values (uid, k);
end;
$$ language plpgsql;

-- ---- 1) Arkadaslik istekleri -------------------------------------------
-- insert (yeni istek) ve status->accepted (kabul) degisikliklerinde iki tarafa
-- da olay yazilir; tarafin ayni degisikligi kendi ekrani tetiklediyse istemci
-- son veriyi zaten gormus olur (dedupe, zararsiz).
create or replace function public.ylauncher_on_friendship_change() returns trigger as $$
declare
  old_status text;
begin
  if tg_op = 'UPDATE' then
    old_status := old.status;
  else
    old_status := null;
  end if;

  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.ylauncher_notify(new.friend_id, 'friend_request');
    perform public.ylauncher_notify(new.user_id, 'friend_request');
  elsif tg_op = 'UPDATE' and old_status <> new.status then
    perform public.ylauncher_notify(new.user_id, 'friend_update');
    perform public.ylauncher_notify(new.friend_id, 'friend_update');
  elsif tg_op = 'DELETE' then
    perform public.ylauncher_notify(old.user_id, 'friend_update');
    perform public.ylauncher_notify(old.friend_id, 'friend_update');
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists ylauncher_friendship_trg on public.ylauncher_friendships;
create trigger ylauncher_friendship_trg
  after insert or update of status or delete on public.ylauncher_friendships
  for each row execute function public.ylauncher_on_friendship_change();

-- ---- 2) Whitelist istekleri --------------------------------------------
create or replace function public.ylauncher_on_wlreq_change() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    perform public.ylauncher_notify(new.host_id, 'wl_request');
    perform public.ylauncher_notify(new.requester_id, 'wl_request');
  elsif tg_op = 'UPDATE' and old.status <> new.status then
    perform public.ylauncher_notify(new.host_id, 'wl_request');
    perform public.ylauncher_notify(new.requester_id, 'wl_request');
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists ylauncher_wlreq_trg on public.ylauncher_whitelist_requests;
create trigger ylauncher_wlreq_trg
  after insert or update of status on public.ylauncher_whitelist_requests
  for each row execute function public.ylauncher_on_wlreq_change();

-- ---- 3) Sunucu duyurulari ----------------------------------------------
-- Upsert + withdraw: yalnizca host'un arkadaslarina bildir (host'un kendisi
-- zaten ne yaptigini biliyor ama zararsiz, dahil).
create or replace function public.ylauncher_on_server_announce() returns trigger as $$
begin
  insert into public.ylauncher_events (user_id, kind)
  select f.friend_id, 'servers'
  from public.ylauncher_friendships f
  where f.user_id = new.host_id and f.status = 'accepted';
  -- host'un kendisi
  insert into public.ylauncher_events (user_id, kind) values (new.host_id, 'servers');
  return null;
end;
$$ language plpgsql;

drop trigger if exists ylauncher_server_announce_trg on public.ylauncher_servers;
create trigger ylauncher_server_announce_trg
  after insert or update of address, port, mc_version, announced_at on public.ylauncher_servers
  for each row execute function public.ylauncher_on_server_announce();

-- (ayri fonksiyon: delete trigger'inda NEW yok) — trigger'dan once tanimli olmali
create or replace function public.ylauncher_on_server_announce_del() returns trigger as $$
begin
  insert into public.ylauncher_events (user_id, kind)
  select f.friend_id, 'servers'
  from public.ylauncher_friendships f
  where f.user_id = old.host_id and f.status = 'accepted';
  insert into public.ylauncher_events (user_id, kind) values (old.host_id, 'servers');
  return null;
end;
$$ language plpgsql;

drop trigger if exists ylauncher_server_withdraw_trg on public.ylauncher_servers;
create trigger ylauncher_server_withdraw_trg
  after delete on public.ylauncher_servers
  for each row execute function public.ylauncher_on_server_announce_del();

-- ---- 4) Kick raporlari --------------------------------------------------
-- Oyuncuya (nickname_ci eslesen launcher kullanicisina) bildir; host'a degil.
create or replace function public.ylauncher_on_kick() returns trigger as $$
begin
  insert into public.ylauncher_events (user_id, kind)
  select u.id, 'kick'
  from public.ylauncher_users u
  where lower(u.nickname) = new.nickname_ci
  limit 1;
  return null;
end;
$$ language plpgsql;

drop trigger if exists ylauncher_kick_trg on public.ylauncher_server_kicks;
create trigger ylauncher_kick_trg
  after insert or update on public.ylauncher_server_kicks
  for each row execute function public.ylauncher_on_kick();
