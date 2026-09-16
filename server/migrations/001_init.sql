-- ============================================================
-- MC Friends Launcher - Supabase migration (paylasilan proje)
-- Tum tablolar "ylauncher_" oneki ile olusturulur.
-- ============================================================

create table if not exists public.ylauncher_users (
  id            bigint generated always as identity primary key,
  nickname      text not null,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

-- Nickname benzersizligi buyuk/kucuk harf duyarsiz (teststeve = TestSteve)
create unique index if not exists uq_ylauncher_users_nickname_ci
  on public.ylauncher_users (lower(nickname));

create table if not exists public.ylauncher_friendships (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references public.ylauncher_users(id) on delete cascade,
  friend_id  bigint not null references public.ylauncher_users(id) on delete cascade,
  status     text not null check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  unique (user_id, friend_id)
);

create index if not exists idx_ylauncher_friendships_user
  on public.ylauncher_friendships (user_id);

create index if not exists idx_ylauncher_friendships_friend
  on public.ylauncher_friendships (friend_id);
