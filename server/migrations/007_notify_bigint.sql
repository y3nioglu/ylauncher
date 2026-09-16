-- 006 integer imzali ylauncher_notify ile uygulandi; trigger'lar bigint
-- kolon degerleri gectigi icin 42883 ile patliyor. Imzayi bigint'e cek.
-- (integer surumu da tutarli dursun diye overload olarak birakildi.)
create or replace function public.ylauncher_notify(uid bigint, k text) returns void as $$
begin
  insert into public.ylauncher_events (user_id, kind) values (uid, k);
end;
$$ language plpgsql;

-- Kucuk id'ler icin integer imzasi da gecerli olsun (overload)
create or replace function public.ylauncher_notify(uid integer, k text) returns void as $$
begin
  perform public.ylauncher_notify(uid::bigint, k);
end;
$$ language plpgsql;
