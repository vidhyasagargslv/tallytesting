import { getDb } from '../db.js'

export function status() {
  const db = getDb()
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    outbox: db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all(),
    local: { masters: count('SELECT COUNT(*) n FROM local_masters'), vouchers: count('SELECT COUNT(*) n FROM local_vouchers') },
    pulled: db.prepare('SELECT object_type, COUNT(*) AS n FROM tally_objects GROUP BY object_type').all(),
    syncState: db.prepare('SELECT * FROM sync_state ORDER BY object_type').all(),
    schemaFields: count('SELECT COUNT(*) n FROM schema_fields')
  }
}

export function outbox(limit = 300) {
  return getDb().prepare('SELECT id, entity, entity_kind, entity_id, label, priority, status, action, attempts, error, created_at, updated_at, synced_at FROM outbox ORDER BY id DESC LIMIT ?').all(limit)
}
export function outboxDetail(id: number) {
  return getDb().prepare('SELECT * FROM outbox WHERE id=?').get(id)
}

export function tallyMasters(type: string) {
  return getDb().prepare('SELECT * FROM t_masters WHERE object_type=? ORDER BY name').all(type)
}

export function tallyVouchers(type?: string) {
  const db = getDb()
  return type
    ? db.prepare('SELECT * FROM t_vouchers WHERE voucher_type=? ORDER BY date DESC, masterid DESC').all(type)
    : db.prepare('SELECT * FROM t_vouchers ORDER BY date DESC, masterid DESC').all()
}

export function tallyVoucher(guid: string) {
  const db = getDb()
  return {
    voucher: db.prepare('SELECT * FROM t_vouchers WHERE guid=?').get(guid),
    ledgerEntries: db.prepare('SELECT * FROM t_voucher_ledger_entries WHERE voucher_guid=? ORDER BY idx').all(guid),
    inventoryEntries: db.prepare('SELECT * FROM t_voucher_inventory_entries WHERE voucher_guid=? ORDER BY idx').all(guid)
  }
}

export function rawObject(type: string, guid: string) {
  const r = getDb().prepare('SELECT * FROM tally_objects WHERE object_type=? AND guid=?').get(type, guid) as any
  return r ? { ...r, raw_json: JSON.parse(r.raw_json) } : undefined
}

export function stock() {
  return getDb().prepare('SELECT * FROM t_stock_summary ORDER BY item, source, godown').all()
}

export function schemaTypes() {
  return getDb().prepare('SELECT object_type, COUNT(*) AS fields, MAX(last_seen) AS last_seen FROM schema_fields GROUP BY object_type ORDER BY object_type').all()
}
export function schemaFields(type: string, q = '') {
  return getDb().prepare("SELECT * FROM schema_fields WHERE object_type=? AND path LIKE ? ORDER BY path").all(type, `%${q}%`)
}
