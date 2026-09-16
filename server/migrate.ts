import 'dotenv/config'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    console.error('HATA: DATABASE_URL tanimli degil. Kok dizinde .env dosyasi olusturun (.env.example ornek).')
    process.exit(1)
  }

  const sql = postgres(DATABASE_URL, { max: 1 })

  // Paylasilan projede cakismamasi icin takip tablosu da prefixli
  await sql`
    create table if not exists public.ylauncher_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `

  const applied = new Set(
    (await sql`select name from public.ylauncher_migrations`).map((r) => r.name)
  )

  const dir = path.join(process.cwd(), 'server', 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  let ran = 0
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= atlandi (zaten uygulanmis): ${file}`)
      continue
    }
    const content = readFileSync(path.join(dir, file), 'utf8')
    console.log(`+ uygulanıyor: ${file}`)
    await sql.unsafe(content)
    await sql`insert into public.ylauncher_migrations (name) values (${file})`
    ran++
  }

  console.log(
    ran === 0 ? 'Migrationlar guncel, yapilacak bir sey yok.' : `${ran} migration uygulandi. Tamamlandi.`
  )
  await sql.end({ timeout: 5 })
}

main().catch((err) => {
  console.error('Migration basarisiz:', err.message)
  process.exit(1)
})
