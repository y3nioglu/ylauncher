import postgres from 'postgres'
import bcrypt from 'bcryptjs'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  // Hata mesaji net olsun: .env eksik
  throw new Error(
    'DATABASE_URL tanimli degil. Kok dizinde .env olusturun (orn: .env.example) ve "npm run migrate" calistirin.'
  )
}

export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10
})

export const NICKNAME_RE = /^[a-zA-Z0-9_]{3,16}$/

export interface UserRow {
  id: number
  nickname: string
  created_at: Date
  last_seen_at: Date | null
}

// ---- Sifre yardimcilari -------------------------------------------------
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash)
}

// ---- Kullanici sorgulari ------------------------------------------------
export async function findUserByNickname(nickname: string): Promise<UserRow | undefined> {
  const rows = await sql<UserRow[]>`
    select id::int, nickname, created_at, last_seen_at
    from public.ylauncher_users
    where lower(nickname) = ${nickname.toLowerCase()}
    limit 1
  `
  return rows[0]
}

export async function createUser(nickname: string, plainPassword: string): Promise<UserRow> {
  const rows = await sql<UserRow[]>`
    insert into public.ylauncher_users (nickname, password_hash)
    values (${nickname}, ${hashPassword(plainPassword)})
    returning id::int, nickname, created_at, last_seen_at
  `
  return rows[0]
}

export async function getPasswordHash(userId: number): Promise<string | undefined> {
  const rows = await sql`
    select password_hash from public.ylauncher_users where id = ${userId} limit 1
  `
  return rows[0]?.password_hash
}

export async function touchLastSeen(userId: number): Promise<void> {
  await sql`update public.ylauncher_users set last_seen_at = now() where id = ${userId}`
}

// ---- Arkadaslik sorgulari ----------------------------------------------
export interface FriendRow {
  id: number
  nickname: string
  last_seen_at: Date | null
}

export interface FriendshipRow {
  id: number
  user_id: number
  friend_id: number
  status: 'pending' | 'accepted' | 'declined'
}

export async function getFriendshipById(id: number): Promise<FriendshipRow | undefined> {
  const rows = await sql<FriendshipRow[]>`
    select id::int, user_id::int, friend_id::int, status
    from public.ylauncher_friendships where id = ${id} limit 1
  `
  return rows[0]
}

export async function findFriendshipBetween(a: number, b: number): Promise<FriendshipRow | undefined> {
  const rows = await sql<FriendshipRow[]>`
    select id::int, user_id::int, friend_id::int, status
    from public.ylauncher_friendships
    where (user_id = ${a} and friend_id = ${b}) or (user_id = ${b} and friend_id = ${a})
    limit 1
  `
  return rows[0]
}

export async function createFriendRequest(fromId: number, toId: number): Promise<FriendshipRow> {
  const rows = await sql<FriendshipRow[]>`
    insert into public.ylauncher_friendships (user_id, friend_id, status)
    values (${fromId}, ${toId}, 'pending')
    returning id::int, user_id::int, friend_id::int, status
  `
  return rows[0]
}

// Istegi kabul et + cift yonlu accepted kaydi garantile
export async function acceptFriendship(requestId: number): Promise<void> {
  const rows = await sql<FriendshipRow[]>`
    update public.ylauncher_friendships set status = 'accepted'
    where id = ${requestId}
    returning id::int, user_id::int, friend_id::int, status
  `
  const f = rows[0]
  if (f) {
    await sql`
      insert into public.ylauncher_friendships (user_id, friend_id, status)
      values (${f.friend_id}, ${f.user_id}, 'accepted')
      on conflict (user_id, friend_id) do update set status = 'accepted'
    `
  }
}

export async function deleteFriendshipById(id: number): Promise<void> {
  await sql`delete from public.ylauncher_friendships where id = ${id}`
}

// iki yonlu kabul edilmis arkadasligi sil; silinen satir sayisini dondur
export async function deleteFriendshipPair(a: number, b: number): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    delete from public.ylauncher_friendships
    where (user_id = ${a} and friend_id = ${b}) or (user_id = ${b} and friend_id = ${a})
    returning id::int
  `
  return rows.length
}

export async function listAcceptedFriends(userId: number): Promise<FriendRow[]> {
  return sql<FriendRow[]>`
    select u.id::int, u.nickname, u.last_seen_at
    from public.ylauncher_friendships f
    join public.ylauncher_users u on u.id = f.friend_id
    where f.user_id = ${userId} and f.status = 'accepted'
    order by u.nickname
  `
}

export async function listIncomingRequests(userId: number): Promise<(FriendRow & { requestId: number })[]> {
  return sql<(FriendRow & { requestId: number })[]>`
    select f.id::int as "requestId", u.id::int, u.nickname, u.last_seen_at
    from public.ylauncher_friendships f
    join public.ylauncher_users u on u.id = f.user_id
    where f.friend_id = ${userId} and f.status = 'pending'
    order by f.created_at desc
  `
}

export async function listOutgoingRequests(userId: number): Promise<(FriendRow & { requestId: number })[]> {
  return sql<(FriendRow & { requestId: number })[]>`
    select f.id::int as "requestId", u.id::int, u.nickname, u.last_seen_at
    from public.ylauncher_friendships f
    join public.ylauncher_users u on u.id = f.friend_id
    where f.user_id = ${userId} and f.status = 'pending'
    order by f.created_at desc
  `
}

// Nickname on-ek aramasi (otomatik tamamlama)
// İliski bilgisi de doner: self/friends/pending_out/pending_in/none
export async function searchUsersByPrefix(
  query: string,
  excludeUserId: number,
  limit = 8
): Promise<{ id: number; nickname: string; relation: string }[]> {
  const q = query.toLowerCase()
  const rows = await sql<{ id: number; nickname: string; relation: string }[]>`
    with me_friends as (
      select friend_id as uid from public.ylauncher_friendships
      where user_id = ${excludeUserId} and status = 'accepted'
    ),
    me_out as (
      select friend_id as uid from public.ylauncher_friendships
      where user_id = ${excludeUserId} and status = 'pending'
    ),
    me_in as (
      select user_id as uid from public.ylauncher_friendships
      where friend_id = ${excludeUserId} and status = 'pending'
    )
    select
      u.id::int,
      u.nickname,
      case
        when u.id = ${excludeUserId} then 'self'
        when u.id in (select uid from me_friends) then 'friends'
        when u.id in (select uid from me_out) then 'pending_out'
        when u.id in (select uid from me_in) then 'pending_in'
        else 'none'
      end as relation
    from public.ylauncher_users u
    where lower(u.nickname) like ${q + '%'}
    order by u.nickname
    limit ${limit}
  `
  return rows
}

export async function pingDb(): Promise<boolean> {
  try {
    await sql`select 1`
    return true
  } catch {
    return false
  }
}

// Surec kapanirken baglantilari duzgun kapat
export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 })
}
