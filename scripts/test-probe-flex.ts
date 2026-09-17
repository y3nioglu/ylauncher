// probe.ts esnek JSON ayristirici testi — bore benzeri tunnel simülasyonu.
// Senaryo: oyuncu akisina {"Accept":...} kontrol cercevesi enjekte edilip
// ardindan duzgun varint cerceveli status yaniti gonderiliyor.
// Eski kati ayristirici bu durumda 'sorgulanamadi' döndürüyordu.
import net from 'node:net'
import { probeServer } from '../src/main/probe'

function vi(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v)
      return Buffer.from(bytes)
    }
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
}

const STATUS = JSON.stringify({
  version: { name: '1.21.11' },
  players: { online: 2, max: 20 },
  description: { text: 'Test sunucusu' },
  favicon: 'data:image/png;base64,iVBORw0KGgo='
})

const server = net.createServer((sock) => {
  sock.once('data', () => {
    // Tunnel kontrol cercevesi (oyuncu akisina enjekte edilen)
    sock.write(Buffer.from('{"Accept":"test-uuid"}\n'))
    // Ardindan Paper'in gercek status yaniti (varint cerceveli)
    const body = Buffer.concat([Buffer.from([0x00]), vi(Buffer.byteLength(STATUS)), Buffer.from(STATUS, 'utf8')])
    sock.write(Buffer.concat([vi(body.length), body]))
  })
})

server.listen(0, '127.0.0.1', async () => {
  const addr = server.address() as net.AddressInfo
  // Senaryo 1: Accept cercevesi + status (tunnel simülasyonu)
  const r1 = await probeServer('127.0.0.1', addr.port, 2000)
  console.log('tunnel-sim:', JSON.stringify(r1))
  // Senaryo 2: baglanti reddi (kapali port)
  server.close(() => {
    probeServer('127.0.0.1', addr.port, 1000).then((r2) => {
      console.log('closed-port:', JSON.stringify(r2))
      process.exit(r1.online && r1.players?.online === 2 && !r2.online ? 0 : 1)
    })
  })
})
