import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

export type DB = Database.Database

const SCHEMA = `
-- ===== Data created in THIS app (to be pushed to Tally) =====
CREATE TABLE IF NOT EXISTS local_masters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- group | ledger | unit | stock_group | godown | stock_item
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS local_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- sales_order | sales | purchase_order | purchase | receipt | payment
  voucher_number TEXT NOT NULL UNIQUE,  -- fixed number = idempotency key in Tally
  date TEXT NOT NULL,
  party TEXT NOT NULL,
  total REAL NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Push queue =====
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,            -- master | voucher
  entity_kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  priority INTEGER NOT NULL,       -- dependency order: groups < units < godowns < stock groups < ledgers < items < vouchers
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  action TEXT,                     -- Create | Alter (decided at push time by looking up Tally)
  attempts INTEGER NOT NULL DEFAULT 0,
  request_xml TEXT,
  response_xml TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_status ON outbox(status, priority, id);

-- ===== Local id <-> Tally identity =====
CREATE TABLE IF NOT EXISTS tally_map (
  entity TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  entity_kind TEXT NOT NULL,
  tally_name TEXT,
  voucher_type TEXT,
  voucher_number TEXT,
  guid TEXT,
  masterid INTEGER,
  alterid INTEGER,
  last_action TEXT,
  last_synced_at TEXT,
  PRIMARY KEY (entity, local_id)
);

-- ===== Everything pulled from Tally: FULL raw object =====
CREATE TABLE IF NOT EXISTS tally_objects (
  object_type TEXT NOT NULL,       -- company | group | ledger | unit | stock_group | godown | stock_item | voucher_type | voucher
  guid TEXT NOT NULL,
  name TEXT,
  masterid INTEGER,
  alterid INTEGER,
  raw_xml TEXT NOT NULL,           -- exact XML element as Tally sent it
  raw_json TEXT NOT NULL,          -- lossless JSON of every element/attribute (attributes prefixed @)
  first_pulled_at TEXT NOT NULL DEFAULT (datetime('now')),
  pulled_at TEXT NOT NULL,
  PRIMARY KEY (object_type, guid)
);

-- ===== Normalized views used by the UI =====
CREATE TABLE IF NOT EXISTS t_masters (
  object_type TEXT NOT NULL,
  guid TEXT NOT NULL,
  name TEXT,
  parent TEXT,
  reserved_name TEXT,
  masterid INTEGER,
  alterid INTEGER,
  opening_balance REAL,            -- Tally sign: negative = Debit
  closing_balance REAL,
  closing_qty REAL,
  closing_value REAL,
  base_units TEXT,
  gstin TEXT,
  state_name TEXT,
  hsn TEXT,
  gst_rate REAL,
  PRIMARY KEY (object_type, guid)
);
CREATE TABLE IF NOT EXISTS t_vouchers (
  guid TEXT PRIMARY KEY,
  masterid INTEGER,
  alterid INTEGER,
  date TEXT,
  voucher_type TEXT,
  voucher_number TEXT,
  reference TEXT,
  party TEXT,
  amount REAL,
  narration TEXT,
  is_cancelled INTEGER,
  is_optional INTEGER
);
CREATE TABLE IF NOT EXISTS t_voucher_ledger_entries (
  voucher_guid TEXT NOT NULL,
  idx INTEGER NOT NULL,
  source TEXT NOT NULL,            -- ledger_entries | accounting_allocation
  ledger TEXT,
  amount REAL,                     -- Tally sign: negative = Debit
  is_deemed_positive INTEGER,
  is_party INTEGER
);
CREATE TABLE IF NOT EXISTS t_voucher_inventory_entries (
  voucher_guid TEXT NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT,
  godown TEXT,
  batch TEXT,
  qty REAL,
  unit TEXT,
  rate REAL,
  amount REAL,
  is_deemed_positive INTEGER       -- 1 = inward
);
CREATE INDEX IF NOT EXISTS ix_vle ON t_voucher_ledger_entries(voucher_guid);
CREATE INDEX IF NOT EXISTS ix_vie ON t_voucher_inventory_entries(voucher_guid);
CREATE TABLE IF NOT EXISTS t_stock_summary (
  item TEXT NOT NULL,
  godown TEXT NOT NULL,            -- '*' = all godowns (Tally's own item closing)
  qty REAL,
  unit TEXT,
  value REAL,
  source TEXT NOT NULL,            -- tally_closing | computed
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item, godown, source)
);

-- ===== Sync bookkeeping =====
CREATE TABLE IF NOT EXISTS sync_state (
  object_type TEXT PRIMARY KEY,
  last_alterid INTEGER NOT NULL DEFAULT 0,
  last_pulled_at TEXT,
  last_count INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS pull_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT,
  since_alterid INTEGER,
  objects INTEGER,
  response_bytes INTEGER,
  error TEXT,
  request_xml TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Schema explorer: every field path ever seen per object type =====
CREATE TABLE IF NOT EXISTS schema_fields (
  object_type TEXT NOT NULL,
  path TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  sample_value TEXT,
  tally_type TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (object_type, path)
);
`

let db: DB | undefined

export function getDb(): DB {
  if (db) return db
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export function closeDb() {
  db?.close()
  db = undefined
}

export const now = () => new Date().toISOString()
