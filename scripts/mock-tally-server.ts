/**
 * Run the mock Tally as a real HTTP server (default :9000) so you can test the app in TALLY_MODE=real
 * on a Mac, or point the Windows PowerShell test script at it.
 *   npm run mock-tally            (utf-8)
 *   MOCK_UTF16=1 npm run mock-tally
 */
import { config } from '../src/config.js'
import { MockTally } from '../src/mock/mockTally.js'
import { startMockServer } from '../src/mock/server.js'

const port = Number(process.env.MOCK_PORT ?? 9000)
const mock = new MockTally(config.mockStatePath, config.company)
await startMockServer(mock, port, { utf16: process.env.MOCK_UTF16 === '1' })
console.log(`Mock TallyPrime listening on http://localhost:${port} company="${config.company}" state=${config.mockStatePath}`)
