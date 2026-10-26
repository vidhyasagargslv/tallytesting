import { config } from '../config.js'
import { getDb, now } from '../db.js'
import { tally } from '../tally/client.js'
import { OBJECTS, buildLookup, tdlString, type ObjectKey } from '../tally/exports.js'
import {
  VOUCHER_TYPE_NAME, buildMasterXml, buildVoucherXml, importEnvelope,
  type ImportAction, type MasterKind, type VoucherInput
} from '../tally/imports.js'
import { parseImportResponse } from '../tally/responses.js'
import { extractElements, firstTagText, innerOf, num } from '../tally/xml.js'
import { getLocalMaster, getLocalVoucher } from './local.js'

interface OutboxRow {
  id: number; entity: 'master' | 'voucher'; entity_kind: string; entity_id: number; label: string; attempts: number
}

export interface PushSummary { attempted: number; synced: number; failed: number; results: Array<{ id: number; label: string; status: string; action?: string; error?: string }> }

let running: Promise<PushSummary> | undefined

/** Push every pending/failed outbox entry in dependency order (masters first, then vouchers). */
export function pushPending(): Promise<PushSummary> {
  running ??= doPush().finally(() => (running = undefined))
  return running
}

async function doPush(): Promise<PushSummary> {
  const db = getDb()
  const rows = db.prepare("SELECT * FROM outbox WHERE status IN ('pending','failed') ORDER BY priority, id").all() as OutboxRow[]
  const summary: PushSummary = { attempted: 0, synced: 0, failed: 0, results: [] }
  for (const row of rows) {
    summary.attempted++
    const r = await pushOne(row)
    if (r.status === 'synced') summary.synced++
    else summary.failed++
    summary.results.push({ id: row.id, label: row.label, ...r })
  }
  return summary
}

interface Found { guid: string; masterid: number; alterid: number }

async function lookup(key: ObjectKey, filter: string, dates?: { from: string; to: string }): Promise<Found | undefined> {
  const def = OBJECTS[key]
  const xml = await tally().post(buildLookup(def, config.company, filter, dates))
  const el = extractElements(innerOf(xml, 'DATA') || xml, def.tag)[0]
  if (!el) return undefined
  return { guid: firstTagText(el, 'GUID') ?? '', masterid: num(firstTagText(el, 'MASTERID')), alterid: num(firstTagText(el, 'ALTERID')) }
}

export async function pushOne(row: OutboxRow): Promise<{ status: 'synced' | 'failed'; action?: ImportAction; error?: string }> {
  const db = getDb()
  let requestXml = ''
  let responseXml = ''
  let action: ImportAction = 'Create'
  try {
    let found: Found | undefined
    let after: () => Promise<Found | undefined>
    let mapExtra: { tally_name?: string; voucher_type?: string; voucher_number?: string }
    if (row.entity === 'master') {
      const m = getLocalMaster(row.entity_id)
      if (!m) throw new Error('local master not found')
      const kind = m.kind as MasterKind
      const filter = `$Name = ${tdlString(m.name)}`
      found = await lookup(kind as ObjectKey, filter)
      action = found ? 'Alter' : 'Create'
      requestXml = importEnvelope('All Masters', config.company, [buildMasterXml(kind, m.data, action)])
      after = () => lookup(kind as ObjectKey, filter)
      mapExtra = { tally_name: m.name }
    } else {
      const v = getLocalVoucher(row.entity_id)
      if (!v) throw new Error('local voucher not found')
      const input = v.data as VoucherInput
      const vchType = VOUCHER_TYPE_NAME[input.kind]
      const filter = `$VoucherNumber = ${tdlString(input.number)} AND $VoucherTypeName = ${tdlString(vchType)}`
      const dates = { from: input.date < config.fromDate ? input.date : config.fromDate, to: input.date > config.toDate ? input.date : config.toDate }
      found = await lookup('voucher', filter, dates)
      action = found ? 'Alter' : 'Create'
      requestXml = importEnvelope('Vouchers', config.company, [buildVoucherXml(input, action)])
      after = () => lookup('voucher', filter, dates)
      mapExtra = { tally_name: `${vchType}/${input.number}`, voucher_type: vchType, voucher_number: input.number }
    }
    responseXml = await tally().post(requestXml)
    const result = parseImportResponse(responseXml)
    if (!result.ok) {
      const error = result.lineErrors.join(' | ') ||
        `Tally did not create/alter anything (CREATED=${result.created} ALTERED=${result.altered} ERRORS=${result.errors} EXCEPTIONS=${result.exceptions} IGNORED=${result.ignored})`
      throw new Error(error)
    }
    const ids = (await after()) ?? found
    db.prepare(`INSERT INTO tally_map(entity, local_id, entity_kind, tally_name, voucher_type, voucher_number, guid, masterid, alterid, last_action, last_synced_at)
      VALUES (@entity,@local_id,@kind,@tally_name,@voucher_type,@voucher_number,@guid,@masterid,@alterid,@action,@at)
      ON CONFLICT(entity, local_id) DO UPDATE SET tally_name=excluded.tally_name, voucher_type=excluded.voucher_type, voucher_number=excluded.voucher_number,
        guid=COALESCE(excluded.guid, guid), masterid=COALESCE(excluded.masterid, masterid), alterid=COALESCE(excluded.alterid, alterid),
        last_action=excluded.last_action, last_synced_at=excluded.last_synced_at`).run({
      entity: row.entity, local_id: row.entity_id, kind: row.entity_kind,
      tally_name: mapExtra.tally_name ?? null, voucher_type: mapExtra.voucher_type ?? null, voucher_number: mapExtra.voucher_number ?? null,
      guid: ids?.guid || null, masterid: ids?.masterid || (row.entity === 'voucher' ? result.lastVchId : result.lastMid) || null,
      alterid: ids?.alterid || null, action, at: now()
    })
    db.prepare("UPDATE outbox SET status='synced', action=?, attempts=attempts+1, request_xml=?, response_xml=?, error=NULL, updated_at=?, synced_at=? WHERE id=?")
      .run(action, requestXml, responseXml, now(), now(), row.id)
    return { status: 'synced', action }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    db.prepare("UPDATE outbox SET status='failed', action=?, attempts=attempts+1, request_xml=?, response_xml=?, error=?, updated_at=? WHERE id=?")
      .run(action, requestXml || null, responseXml || null, error, now(), row.id)
    return { status: 'failed', action, error }
  }
}
