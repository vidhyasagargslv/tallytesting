import { config } from '../config.js'
import { getDb, now, type DB } from '../db.js'
import { tally } from '../tally/client.js'
import { OBJECTS, PULL_ORDER, buildCollectionExport, type ObjectKey } from '../tally/exports.js'
import { exportError } from '../tally/responses.js'
import { asArray, extractElements, flattenPaths, innerOf, num, parseXml, text } from '../tally/xml.js'

export interface PullResult { objectType: ObjectKey; since: number; objects: number; maxAlterId: number; bytes: number; error?: string }

let running: Promise<PullResult[]> | undefined

/**
 * Pull everything from Tally. Incremental by default (only objects with ALTERID > last seen per type).
 * full=true re-pulls everything and removes local copies of objects no longer in Tally.
 */
export function pullAll(opts: { full?: boolean; only?: ObjectKey[] } = {}): Promise<PullResult[]> {
  running ??= doPull(opts).finally(() => (running = undefined))
  return running
}

async function doPull({ full = false, only }: { full?: boolean; only?: ObjectKey[] }): Promise<PullResult[]> {
  const db = getDb()
  const results: PullResult[] = []
  for (const key of PULL_ORDER) {
    if (only && !only.includes(key)) continue
    results.push(await pullType(db, key, full))
  }
  if (!only || only.includes('ledger') || only.includes('stock_item')) await refreshBalances(db)
  rebuildStockSummary(db)
  reconcileMap(db)
  return results
}

async function pullType(db: DB, key: ObjectKey, full: boolean): Promise<PullResult> {
  const def = OBJECTS[key]
  const state = db.prepare('SELECT last_alterid FROM sync_state WHERE object_type=?').get(key) as { last_alterid: number } | undefined
  const since = full || !def.incremental ? 0 : state?.last_alterid ?? 0
  const requestXml = buildCollectionExport(def, { company: config.company, sinceAlterId: since, fromDate: config.fromDate, toDate: config.toDate })
  const startedAt = now()
  let xml = ''
  try {
    xml = await tally().post(requestXml)
    const err = exportError(xml)
    if (err) throw new Error(err)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    db.prepare('INSERT INTO sync_state(object_type,last_error) VALUES (?,?) ON CONFLICT(object_type) DO UPDATE SET last_error=excluded.last_error').run(key, error)
    db.prepare('INSERT INTO pull_log(object_type,since_alterid,objects,response_bytes,error,request_xml) VALUES (?,?,?,?,?,?)').run(key, since, 0, xml.length, error, requestXml)
    return { objectType: key, since, objects: 0, maxAlterId: since, bytes: xml.length, error }
  }

  const elements = extractElements(innerOf(xml, 'DATA') || xml, def.tag)
  let maxAlter = since
  const tx = db.transaction(() => {
    for (const el of elements) {
      const json = parseXml(el)[def.tag] ?? {}
      const alterid = num(json.ALTERID)
      maxAlter = Math.max(maxAlter, alterid)
      saveObject(db, key, el, json, startedAt)
    }
    if (full || !def.incremental) {
      // mirror: drop objects that Tally no longer returns
      const stale = db.prepare('SELECT guid FROM tally_objects WHERE object_type=? AND pulled_at < ?').all(key, startedAt) as { guid: string }[]
      for (const s of stale) deleteObject(db, key, s.guid)
    }
    db.prepare(`INSERT INTO sync_state(object_type,last_alterid,last_pulled_at,last_count,last_error) VALUES (?,?,?,?,NULL)
      ON CONFLICT(object_type) DO UPDATE SET last_alterid=excluded.last_alterid, last_pulled_at=excluded.last_pulled_at, last_count=excluded.last_count, last_error=NULL`)
      .run(key, maxAlter, startedAt, elements.length)
    db.prepare('INSERT INTO pull_log(object_type,since_alterid,objects,response_bytes,request_xml) VALUES (?,?,?,?,?)').run(key, since, elements.length, xml.length, requestXml)
  })
  tx()
  return { objectType: key, since, objects: elements.length, maxAlterId: maxAlter, bytes: xml.length }
}

function objName(key: ObjectKey, j: any): string {
  if (key === 'voucher') return `${text(j.VOUCHERTYPENAME) || j['@VCHTYPE'] || ''}/${text(j.VOUCHERNUMBER)}`
  return String(j['@NAME'] ?? '') || text(j.NAME) || text(j['LANGUAGENAME.LIST']?.[0]?.['NAME.LIST']?.[0]?.NAME)
}

function saveObject(db: DB, key: ObjectKey, rawXml: string, j: any, at: string) {
  const name = objName(key, j)
  const guid = text(j.GUID) || String(j['@REMOTEID'] ?? '') || `${key}:${name}`
  db.prepare(`INSERT INTO tally_objects(object_type,guid,name,masterid,alterid,raw_xml,raw_json,pulled_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(object_type,guid) DO UPDATE SET name=excluded.name, masterid=excluded.masterid, alterid=excluded.alterid,
      raw_xml=excluded.raw_xml, raw_json=excluded.raw_json, pulled_at=excluded.pulled_at`)
    .run(key, guid, name, num(j.MASTERID) || null, num(j.ALTERID) || null, rawXml, JSON.stringify(j), at)
  recordSchema(db, key, j, at)
  if (key === 'voucher') saveVoucher(db, guid, j)
  else saveMaster(db, key, guid, name, j)
}

function deleteObject(db: DB, key: ObjectKey, guid: string) {
  db.prepare('DELETE FROM tally_objects WHERE object_type=? AND guid=?').run(key, guid)
  if (key === 'voucher') {
    db.prepare('DELETE FROM t_vouchers WHERE guid=?').run(guid)
    db.prepare('DELETE FROM t_voucher_ledger_entries WHERE voucher_guid=?').run(guid)
    db.prepare('DELETE FROM t_voucher_inventory_entries WHERE voucher_guid=?').run(guid)
  } else db.prepare('DELETE FROM t_masters WHERE object_type=? AND guid=?').run(key, guid)
}

const latest = (list: unknown) => {
  const a = asArray<any>(list)
  return a.length ? a[a.length - 1] : undefined
}

function saveMaster(db: DB, key: ObjectKey, guid: string, name: string, j: any) {
  let gstRate: number | null = null
  let hsn: string | null = null
  const gst = latest(j['GSTDETAILS.LIST'])
  if (gst) {
    hsn = text(gst.HSNCODE) || null
    for (const sw of asArray<any>(gst['STATEWISEDETAILS.LIST']))
      for (const rd of asArray<any>(sw['RATEDETAILS.LIST']))
        if (/IGST|Integrated/i.test(text(rd.GSTRATEDUTYHEAD))) gstRate = num(rd.GSTRATE)
  }
  const mailing = latest(j['LEDMAILINGDETAILS.LIST'])
  const gstReg = latest(j['LEDGSTREGDETAILS.LIST'])
  const has = (v: unknown) => text(v) !== ''
  db.prepare(`INSERT OR REPLACE INTO t_masters(object_type,guid,name,parent,reserved_name,masterid,alterid,opening_balance,closing_balance,closing_qty,closing_value,base_units,gstin,state_name,hsn,gst_rate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    key, guid, name, text(j.PARENT) || null, String(j['@RESERVEDNAME'] ?? '') || null,
    num(j.MASTERID) || null, num(j.ALTERID) || null,
    key === 'ledger' && has(j.OPENINGBALANCE) ? num(j.OPENINGBALANCE) : key === 'stock_item' && has(j.OPENINGBALANCE) ? num(j.OPENINGBALANCE) : null,
    key === 'ledger' && has(j.CLOSINGBALANCE) ? num(j.CLOSINGBALANCE) : null,
    key === 'stock_item' && has(j.CLOSINGBALANCE) ? num(j.CLOSINGBALANCE) : null,
    key === 'stock_item' && has(j.CLOSINGVALUE) ? num(j.CLOSINGVALUE) : null,
    text(j.BASEUNITS) || null,
    text(j.PARTYGSTIN) || text(gstReg?.GSTIN) || null,
    text(j.LEDSTATENAME) || text(mailing?.STATE) || text(j.STATENAME) || null,
    hsn, gstRate
  )
}

function saveVoucher(db: DB, guid: string, j: any) {
  const party = text(j.PARTYLEDGERNAME) || text(j.PARTYNAME)
  db.prepare('DELETE FROM t_voucher_ledger_entries WHERE voucher_guid=?').run(guid)
  db.prepare('DELETE FROM t_voucher_inventory_entries WHERE voucher_guid=?').run(guid)
  const insL = db.prepare('INSERT INTO t_voucher_ledger_entries(voucher_guid,idx,source,ledger,amount,is_deemed_positive,is_party) VALUES (?,?,?,?,?,?,?)')
  const insI = db.prepare('INSERT INTO t_voucher_inventory_entries(voucher_guid,idx,item,godown,batch,qty,unit,rate,amount,is_deemed_positive) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const all = asArray<any>(j['ALLLEDGERENTRIES.LIST'])
  const ledgerEntries = all.length ? all : asArray<any>(j['LEDGERENTRIES.LIST'])
  let idx = 0
  let partyAmount: number | undefined
  let positive = 0
  for (const e of ledgerEntries) {
    const ledger = text(e.LEDGERNAME)
    const amount = num(e.AMOUNT)
    const isParty = text(e.ISPARTYLEDGER) === 'Yes' || ledger === party
    if (isParty && partyAmount === undefined) partyAmount = Math.abs(amount)
    if (amount > 0) positive += amount
    insL.run(guid, idx++, 'ledger_entries', ledger, amount, text(e.ISDEEMEDPOSITIVE) === 'Yes' ? 1 : 0, isParty ? 1 : 0)
  }
  const allInv = asArray<any>(j['ALLINVENTORYENTRIES.LIST'])
  const inv = allInv.length ? allInv : asArray<any>(j['INVENTORYENTRIES.LIST'])
  let iIdx = 0
  for (const e of inv) {
    const item = text(e.STOCKITEMNAME)
    const inward = text(e.ISDEEMEDPOSITIVE) === 'Yes' ? 1 : 0
    const unit = text(e.ACTUALQTY).replace(/^[-\d.\s]+/, '').trim() || text(e.BILLEDQTY).replace(/^[-\d.\s]+/, '').trim()
    const rate = num(e.RATE)
    for (const a of asArray<any>(e['ACCOUNTINGALLOCATIONS.LIST'])) {
      const amt = num(a.AMOUNT)
      if (amt > 0) positive += amt
      insL.run(guid, idx++, 'accounting_allocation', text(a.LEDGERNAME), amt, text(a.ISDEEMEDPOSITIVE) === 'Yes' ? 1 : 0, 0)
    }
    const batches = asArray<any>(e['BATCHALLOCATIONS.LIST'])
    if (batches.length) {
      for (const b of batches)
        insI.run(guid, iIdx++, item, text(b.GODOWNNAME) || null, text(b.BATCHNAME) || null, num(b.ACTUALQTY), unit, rate, num(b.AMOUNT), inward)
    } else insI.run(guid, iIdx++, item, null, null, num(e.ACTUALQTY), unit, rate, num(e.AMOUNT), inward)
  }
  db.prepare(`INSERT OR REPLACE INTO t_vouchers(guid,masterid,alterid,date,voucher_type,voucher_number,reference,party,amount,narration,is_cancelled,is_optional)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    guid, num(j.MASTERID) || null, num(j.ALTERID) || null, text(j.DATE), text(j.VOUCHERTYPENAME) || String(j['@VCHTYPE'] ?? ''),
    text(j.VOUCHERNUMBER), text(j.REFERENCE) || null, party || null, partyAmount ?? positive, text(j.NARRATION) || null,
    text(j.ISCANCELLED) === 'Yes' ? 1 : 0, text(j.ISOPTIONAL) === 'Yes' ? 1 : 0
  )
}

/**
 * Closing balances change when vouchers are entered, but that does NOT bump the ledger's / item's own ALTERID,
 * so an incremental pull would miss them. Refresh balances of ALL ledgers and stock items on every pull
 * with a light export (only the balance fields).
 */
async function refreshBalances(db: DB) {
  const specs: Array<[ObjectKey, string[]]> = [
    ['ledger', ['GUID', 'Name', 'ClosingBalance']],
    ['stock_item', ['GUID', 'Name', 'ClosingBalance', 'ClosingValue', 'ClosingRate']]
  ]
  for (const [key, fetch] of specs) {
    const def = OBJECTS[key]
    try {
      const xml = await tally().post(buildCollectionExport(def, { company: config.company, fetch }))
      if (exportError(xml)) continue
      const upd = key === 'ledger'
        ? db.prepare("UPDATE t_masters SET closing_balance=? WHERE object_type='ledger' AND guid=?")
        : db.prepare("UPDATE t_masters SET closing_qty=?, closing_value=? WHERE object_type='stock_item' AND guid=?")
      db.transaction(() => {
        for (const el of extractElements(innerOf(xml, 'DATA') || xml, def.tag)) {
          const j = parseXml(el)[def.tag] ?? {}
          const guid = text(j.GUID)
          if (!guid) continue
          if (key === 'ledger') upd.run(num(j.CLOSINGBALANCE), guid)
          else upd.run(num(j.CLOSINGBALANCE), num(j.CLOSINGVALUE), guid)
        }
      })()
    } catch {
      /* balances are best-effort; the main pull already reported connectivity errors */
    }
  }
}

/** Schema explorer: remember every distinct field path seen for each object type. */
function recordSchema(db: DB, key: ObjectKey, j: any, at: string) {
  const paths = flattenPaths(j)
  const up = db.prepare(`INSERT INTO schema_fields(object_type,path,occurrences,sample_value,tally_type,first_seen,last_seen) VALUES (?,?,1,?,?,?,?)
    ON CONFLICT(object_type,path) DO UPDATE SET occurrences=occurrences+1, last_seen=excluded.last_seen,
      sample_value=CASE WHEN (sample_value IS NULL OR sample_value='') THEN excluded.sample_value ELSE sample_value END,
      tally_type=CASE WHEN (tally_type IS NULL OR tally_type='') THEN excluded.tally_type ELSE tally_type END`)
  for (const f of paths.values()) up.run(key, f.path, f.sample.slice(0, 300), f.tallyType, at, at)
}

/**
 * Inventory:
 *  - source 'tally_closing', godown '*': Tally's own CLOSINGBALANCE/CLOSINGVALUE per stock item.
 *  - source 'computed', per godown: opening batch allocations + inward/outward batch allocations of pulled
 *    vouchers (excluding order / optional / cancelled vouchers).
 */
export function rebuildStockSummary(db: DB) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM t_stock_summary').run()
    const items = db.prepare("SELECT o.name, o.raw_json, m.closing_qty, m.closing_value, m.base_units FROM tally_objects o JOIN t_masters m ON m.object_type=o.object_type AND m.guid=o.guid WHERE o.object_type='stock_item'").all() as any[]
    const ins = db.prepare('INSERT OR REPLACE INTO t_stock_summary(item,godown,qty,unit,value,source) VALUES (?,?,?,?,?,?)')
    const computed = new Map<string, { qty: number; unit: string }>()
    const add = (item: string, godown: string, qty: number, unit: string) => {
      const k = `${item}\u0000${godown}`
      const c = computed.get(k) ?? { qty: 0, unit }
      c.qty += qty
      computed.set(k, c)
    }
    const unitOf = new Map<string, string>()
    const rateOf = new Map<string, number>()
    for (const it of items) {
      unitOf.set(it.name, it.base_units ?? '')
      if (it.closing_qty !== null) {
        ins.run(it.name, '*', it.closing_qty, it.base_units, it.closing_value === null ? null : Math.abs(it.closing_value), 'tally_closing')
        if (it.closing_qty) rateOf.set(it.name, Math.abs(it.closing_value ?? 0) / Math.abs(it.closing_qty))
      }
      const j = JSON.parse(it.raw_json)
      for (const b of asArray<any>(j['BATCHALLOCATIONS.LIST'])) add(it.name, text(b.GODOWNNAME) || 'Main Location', num(b.OPENINGBALANCE), it.base_units ?? '')
    }
    const orderTypes = new Set(
      (db.prepare("SELECT name, parent FROM t_masters WHERE object_type='voucher_type'").all() as any[])
        .filter((v) => /order/i.test(v.parent ?? '') || /order/i.test(v.name ?? '')).map((v) => v.name)
    )
    orderTypes.add('Sales Order'); orderTypes.add('Purchase Order')
    const rows = db.prepare(`SELECT i.item, i.godown, i.qty, i.unit, i.is_deemed_positive, v.voucher_type FROM t_voucher_inventory_entries i
      JOIN t_vouchers v ON v.guid=i.voucher_guid WHERE v.is_cancelled=0 AND v.is_optional=0`).all() as any[]
    for (const r of rows) {
      if (orderTypes.has(r.voucher_type)) continue
      add(r.item, r.godown || 'Main Location', r.is_deemed_positive ? r.qty : -r.qty, r.unit || unitOf.get(r.item) || '')
    }
    for (const [k, c] of computed) {
      const [item, godown] = k.split('\u0000')
      const rate = rateOf.get(item)
      ins.run(item, godown, c.qty, c.unit, rate === undefined ? null : Math.round(c.qty * rate * 100) / 100, 'computed')
    }
  })
  tx()
}

/** Link pulled Tally objects to locally created ones (by name / voucher type+number). */
function reconcileMap(db: DB) {
  db.prepare(`UPDATE tally_map SET
      guid = (SELECT guid FROM tally_objects o WHERE o.object_type = tally_map.entity_kind AND o.name = tally_map.tally_name),
      masterid = (SELECT masterid FROM tally_objects o WHERE o.object_type = tally_map.entity_kind AND o.name = tally_map.tally_name),
      alterid = (SELECT alterid FROM tally_objects o WHERE o.object_type = tally_map.entity_kind AND o.name = tally_map.tally_name)
    WHERE entity='master' AND EXISTS (SELECT 1 FROM tally_objects o WHERE o.object_type = tally_map.entity_kind AND o.name = tally_map.tally_name)`).run()
  db.prepare(`UPDATE tally_map SET
      guid = (SELECT guid FROM t_vouchers v WHERE v.voucher_type = tally_map.voucher_type AND v.voucher_number = tally_map.voucher_number),
      masterid = (SELECT masterid FROM t_vouchers v WHERE v.voucher_type = tally_map.voucher_type AND v.voucher_number = tally_map.voucher_number),
      alterid = (SELECT alterid FROM t_vouchers v WHERE v.voucher_type = tally_map.voucher_type AND v.voucher_number = tally_map.voucher_number)
    WHERE entity='voucher' AND EXISTS (SELECT 1 FROM t_vouchers v WHERE v.voucher_type = tally_map.voucher_type AND v.voucher_number = tally_map.voucher_number)`).run()
}
