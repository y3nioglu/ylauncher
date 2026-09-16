import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildProfileCard } from '../src/main/profile'

const root = mkdtempSync(path.join(tmpdir(), 'profile-test-'))

// Bos durum
const empty = buildProfileCard(root, 'testuser')
assert.equal(empty.totalHours, 0)
assert.equal(empty.sessions, 0)
assert.equal(empty.firstPlayed, null)

// playtime.json
writeFileSync(
  path.join(root, 'playtime.json'),
  JSON.stringify({
    totalMs: 3_600_000,
    sessions: [{ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' }],
    lastServer: '1.2.3.4'
  })
)

// sunucu istatistikleri
mkdirSync(path.join(root, 'profiles', 'stats'), { recursive: true })
writeFileSync(
  path.join(root, 'profiles', 'stats', 'default.json'),
  JSON.stringify({
    version: 1,
    totalPlayMs: 1_800_000,
    totalPlayerMs: 600_000,
    sessions: 2,
    firstStart: '2026-08-30T09:00:00Z',
    lastStart: '2026-09-02T20:00:00Z',
    peakPlayers: 3
  })
)

const card = buildProfileCard(root, 'testuser')
assert.equal(card.nickname, 'testuser')
assert.equal(card.totalHours, 1.5)
assert.equal(card.sessions, 3)
assert.equal(card.firstPlayed, '2026-08-30T09:00:00Z')
assert.equal(card.lastPlayed, '2026-09-02T20:00:00Z')
assert.equal(card.multiplayerMinutes, 10)
assert.equal(card.peakPlayers, 3)

console.log('profile.ts testleri OK')
