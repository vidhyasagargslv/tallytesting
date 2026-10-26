import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)

export type TallyMode = 'mock' | 'real'

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export const config = {
  root,
  mode: env('TALLY_MODE', 'mock') as TallyMode,
  tallyUrl: env('TALLY_URL', 'http://localhost:9000'),
  company: env('TALLY_COMPANY', 'Demo Sync Co'),
  timeoutMs: Number(env('TALLY_TIMEOUT_MS', '30000')),
  fromDate: env('TALLY_FROM_DATE', '20260401'),
  toDate: env('TALLY_TO_DATE', '20270331'),
  voucherPrefix: env('VOUCHER_PREFIX', 'TT'),
  dbPath: path.resolve(root, env('DB_PATH', 'data/tallytesting.db')),
  mockStatePath: path.resolve(root, env('MOCK_STATE_PATH', 'data/mock-tally-state.json')),
  port: Number(env('PORT', '4000')),
  autoSyncSeconds: Number(env('AUTO_SYNC_SECONDS', '0'))
}
