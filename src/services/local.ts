import { config } from '../config.js'
import { getDb, now } from '../db.js'
import {
  computeTotals, type MasterInput, type MasterKind, type VoucherInput, type VoucherKind
} from '../tally/imports.js'

export const MASTER_KINDS: MasterKind[] = ['group', 'unit', 'godown', 'stock_group', 'ledger', 'stock_item']
export const VOUCHER_KINDS: VoucherKind[] = ['sales_order', 'sales', 'purchase_order', 'purchase', 'receipt', 'payment']

/** Dependency order for pushing. */
export const PRIORITY: Record<string, number> = {
  group: 10, unit: 20, godown: 30, stock_group: 40, ledger: 50, stock_item: 60, voucher: 100
}

const PREFIX: Record<VoucherKind, string> = {
  sales_order: 'SO', sales: 'SI', purchase_order: 'PO', purchase: 'PI', receipt: 'RC', payment: 'PY'
}

export function createMaster(kind: MasterKind, data: MasterInput & Record<string, unknown>) {
  if (!MASTER_KINDS.includes(kind)) throw new Error(`Unknown master kind ${kind}`)
  const name = String(data.name ?? '').trim()
  if (!name) throw new Error('name is required')
  if (kind === 'ledger' && !(data as any).parent) throw new Error('parent group is required for a ledger')
  if (kind === 'stock_item' && !(data as any).baseUnit) throw new Error('baseUnit is required for a stock item')
  const db = getDb()
  const json = JSON.stringify({ ...data, name })
  const existing = db.prepare('SELECT id FROM local_masters WHERE kind=? AND name=?').get(kind, name) as { id: number } | undefined
  let id: number
  if (existing) {
    db.prepare("UPDATE local_masters SET data_json=?, updated_at=datetime('now') WHERE id=?").run(json, existing.id)
    id = existing.id
  } else {
    id = Number(db.prepare('INSERT INTO local_masters(kind,name,data_json) VALUES (?,?,?)').run(kind, name, json).lastInsertRowid)
  }
  enqueue('master', kind, id, `${kind}: ${name}`, PRIORITY[kind])
  return getLocalMaster(id)
}

export function nextVoucherNumber(kind: VoucherKind): string {
  const db = getDb()
  const pfx = `${config.voucherPrefix}/${PREFIX[kind]}/`
  const row = db.prepare('SELECT COUNT(*) AS n FROM local_vouchers WHERE kind=?').get(kind) as { n: number }
  let n = row.n + 1
  while (db.prepare('SELECT 1 FROM local_vouchers WHERE voucher_number=?').get(`${pfx}${String(n).padStart(4, '0')}`)) n++
  return `${pfx}${String(n).padStart(4, '0')}`
}

export function createVoucher(kind: VoucherKind, data: Omit<VoucherInput, 'kind' | 'number'> & { number?: string }) {
  if (!VOUCHER_KINDS.includes(kind)) throw new Error(`Unknown voucher kind ${kind}`)
  if (!data.party) throw new Error('party is required')
  if (!/^\d{8}$/.test(String(data.date ?? ''))) throw new Error('date must be YYYYMMDD')
  const isInv = kind !== 'receipt' && kind !== 'payment'
  if (isInv && !(data.lines && data.lines.length)) throw new Error('at least one line is required')
  if (!isInv && !(Number(data.amount) > 0)) throw new Error('amount must be > 0')
  const lines = (data.lines ?? []).map((l) => ({ ...l, qty: Number(l.qty), rate: Number(l.rate), gstRate: l.gstRate === undefined || (l.gstRate as unknown) === '' ? undefined : Number(l.gstRate) }))
  const number = data.number?.trim() || nextVoucherNumber(kind)
  const input: VoucherInput = { ...data, lines, amount: data.amount === undefined ? undefined : Number(data.amount), kind, number }
  const totals = computeTotals(input)
  const db = getDb()
  const existing = db.prepare('SELECT id FROM local_vouchers WHERE voucher_number=?').get(number) as { id: number } | undefined
  let id: number
  if (existing) {
    db.prepare("UPDATE local_vouchers SET kind=?, date=?, party=?, total=?, data_json=?, updated_at=datetime('now') WHERE id=?")
      .run(kind, input.date, input.party, totals.total, JSON.stringify(input), existing.id)
    id = existing.id
  } else {
    id = Number(
      db.prepare('INSERT INTO local_vouchers(kind,voucher_number,date,party,total,data_json) VALUES (?,?,?,?,?,?)')
        .run(kind, number, input.date, input.party, totals.total, JSON.stringify(input)).lastInsertRowid
    )
  }
  enqueue('voucher', kind, id, `${kind}: ${number}`, PRIORITY.voucher)
  return getLocalVoucher(id)
}

/** Add (or reset to pending) an outbox entry for an entity. One open entry per entity. */
export function enqueue(entity: 'master' | 'voucher', kind: string, id: number, label: string, priority: number) {
  const db = getDb()
  const open = db.prepare("SELECT id FROM outbox WHERE entity=? AND entity_id=? AND status IN ('pending','failed')").get(entity, id) as { id: number } | undefined
  if (open) {
    db.prepare("UPDATE outbox SET status='pending', label=?, updated_at=? WHERE id=?").run(label, now(), open.id)
    return open.id
  }
  return Number(
    db.prepare('INSERT INTO outbox(entity,entity_kind,entity_id,label,priority) VALUES (?,?,?,?,?)').run(entity, kind, id, label, priority).lastInsertRowid
  )
}

export function requeue(entity: 'master' | 'voucher', id: number) {
  const row = entity === 'master' ? getLocalMaster(id) : getLocalVoucher(id)
  if (!row) throw new Error('not found')
  return enqueue(entity, row.kind, id, `${row.kind}: ${entity === 'master' ? (row as any).name : (row as any).voucher_number}`, PRIORITY[entity === 'master' ? row.kind : 'voucher'])
}

export function getLocalMaster(id: number) {
  const r = getDb().prepare('SELECT * FROM local_masters WHERE id=?').get(id) as any
  return r ? { ...r, data: JSON.parse(r.data_json) } : undefined
}
export function getLocalVoucher(id: number) {
  const r = getDb().prepare('SELECT * FROM local_vouchers WHERE id=?').get(id) as any
  return r ? { ...r, data: JSON.parse(r.data_json) } : undefined
}

export function listLocal() {
  const db = getDb()
  const sync = `LEFT JOIN tally_map m ON m.entity=? AND m.local_id=x.id
    LEFT JOIN (SELECT entity, entity_id, status, error FROM outbox o1 WHERE id=(SELECT MAX(id) FROM outbox o2 WHERE o2.entity=o1.entity AND o2.entity_id=o1.entity_id)) o ON o.entity=? AND o.entity_id=x.id`
  return {
    masters: db.prepare(`SELECT x.id, x.kind, x.name, x.data_json, x.updated_at, m.guid, m.masterid, m.alterid, o.status, o.error FROM local_masters x ${sync} ORDER BY x.id DESC`).all('master', 'master'),
    vouchers: db.prepare(`SELECT x.id, x.kind, x.voucher_number, x.date, x.party, x.total, x.data_json, m.guid, m.masterid, o.status, o.error FROM local_vouchers x ${sync} ORDER BY x.id DESC`).all('voucher', 'voucher')
  }
}

/** Demo data: everything a fresh Tally company needs for a GST sales/purchase round trip. */
export function seedDemoMasters() {
  const m = (kind: MasterKind, d: any) => createMaster(kind, d)
  m('group', { name: 'Online Customers', parent: 'Sundry Debtors' })
  m('unit', { name: 'Nos', formalName: 'Numbers', decimals: 0 })
  m('unit', { name: 'Kg', formalName: 'Kilograms', decimals: 3 })
  m('godown', { name: 'Warehouse A' })
  m('stock_group', { name: 'Electronics' })
  m('ledger', { name: 'Sales', parent: 'Sales Accounts', affectsStock: true })
  m('ledger', { name: 'Purchase', parent: 'Purchase Accounts', affectsStock: true })
  m('ledger', { name: 'CGST', parent: 'Duties & Taxes', gstDutyHead: 'Central Tax', gstRate: 9 })
  m('ledger', { name: 'SGST', parent: 'Duties & Taxes', gstDutyHead: 'State Tax', gstRate: 9 })
  m('ledger', { name: 'IGST', parent: 'Duties & Taxes', gstDutyHead: 'Integrated Tax', gstRate: 18 })
  m('ledger', { name: 'HDFC Bank', parent: 'Bank Accounts' })
  m('ledger', { name: 'Acme Retail Pvt Ltd', parent: 'Online Customers', billWise: true, gstin: '29ABCDE1234F1Z5', state: 'Karnataka', address: 'MG Road, Bengaluru' })
  m('ledger', { name: 'Zen Supplies', parent: 'Sundry Creditors', billWise: true, gstin: '27ABCDE9876K1Z2', state: 'Maharashtra', address: 'Andheri, Mumbai' })
  m('stock_item', { name: 'USB-C Cable 1m', parent: 'Electronics', baseUnit: 'Nos', hsn: '85444299', gstRate: 18, openingQty: 100, openingRate: 120, godown: 'Main Location' })
  m('stock_item', { name: 'Wireless Mouse', parent: 'Electronics', baseUnit: 'Nos', hsn: '84716060', gstRate: 18, openingQty: 40, openingRate: 450, godown: 'Warehouse A' })
}
