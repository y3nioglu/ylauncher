-- Cift adres duyurusu: host'un dogrudan adresi erisilemezse (bulut guvenlik
-- grubu 25565'i disariya kapatmis olabilir) katilan taraf turel adresini
-- dener. Turel portu bore sunucusunun atadigi rastgele porttur.
alter table public.ylauncher_servers
  add column if not exists tunnel_address text,
  add column if not exists tunnel_port int;
