import fs from 'node:fs'
import { config } from '../src/config.js'
for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`, config.mockStatePath]) {
  if (fs.existsSync(f)) { fs.rmSync(f); console.log('removed', f) }
}
