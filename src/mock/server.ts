import http from 'node:http'
import { decodeTallyBytes } from '../tally/client.js'
import type { MockTally } from './mockTally.js'

/** Serve a MockTally over HTTP exactly like TallyPrime's XML port (POST any path). */
export function startMockServer(mock: MockTally, port: number, opts: { utf16?: boolean } = {}): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const xml = decodeTallyBytes(Buffer.concat(chunks))
      let out: string
      try {
        out = mock.handle(xml)
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
        return
      }
      if (opts.utf16) {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-16' })
        res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(out, 'utf16le')]))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
        res.end(out)
      }
    })
  })
  return new Promise((resolve) => server.listen(port, () => resolve(server)))
}
