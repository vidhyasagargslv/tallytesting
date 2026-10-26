/**
 * Mock end-to-end test: create masters -> push -> create vouchers -> push -> pull -> verify
 * stock, sales, ledgers, schema explorer, idempotency (Alter instead of duplicate), incremental pull,
 * Tally error handling, and the HTTP client path with a UTF-16 response.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const tmp = path.resolve(import.meta.dirname, '..', 'data', 'tmp')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
process.env.TALLY_MODE = 'mock'
process.env.DB_PATH = path.join(tmp, 'e2e.db')
process.env.MOCK_STATE_PATH = path.join(tmp, 'e2e-mock.json')
process.env.TALLY_COMPANY = 'Demo Sync Co'

const { config } = await import('../src/config.js')
const { getDb } = await import('../src/db.js')
const local = await import('../src/services/local.js')
const { pushPending } = await import('../src/services/push.js')
const { pullAll } = await import('../src/services/pull.js')
const q = await import('../src/services/query.js')
const { getMockTally, MockTally } = await import('../src/mock/mockTally.js')
const { TallyClient } = await import('../src/tally/client.js')
const { startMockServer } = await import('../src/mock/server.js')
const { OBJECTS, buildCollectionExport } = await import('../src/tally/exports.js')
const { importEnvelope } = await import('../src/tally/imports.js')
const { parseImportResponse } = await import('../src/tally/responses.js')
const { extractElements, innerOf } = await import('../src/tally/xml.js')

let step = 0
const ok = (msg: string) => console.log(`  ✔ ${++step}. ${msg}`)
const db = getDb()
const one = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T

console.log(`E2E (mode=${config.mode}, db=${config.dbPath})`)

// 1. masters
local.seedDemoMasters()
let push = await pushPending()
assert.equal(push.failed, 0, JSON.stringify(push.results.filter((r) => r.status !== 'synced')))
assert.equal(push.synced, 15)
ok(`pushed ${push.synced} masters (groups, units, godown, stock group, ledgers, stock items) in dependency order`)

// 2. vouchers
const si = local.createVoucher('sales', {
  date: '20260415', party: 'Acme Retail Pvt Ltd', taxMode: 'intra',
  lines: [{ item: 'USB-C Cable 1m', qty: 10, rate: 200, gstRate: 18 }, { item: 'Wireless Mouse', qty: 2, rate: 900, gstRate: 18, godown: 'Warehouse A' }]
})
assert.equal(si.total, 4484) // (2000+1800) * 1.18
push = await pushPending()
assert.equal(push.synced, 1, JSON.stringify(push.results))
assert.equal(push.results[0].action, 'Create')
ok(`sales invoice ${si.voucher_number} pushed (total ${si.total})`)

local.createVoucher('sales_order', { date: '20260416', party: 'Acme Retail Pvt Ltd', taxMode: 'intra', dueDate: '20260430', lines: [{ item: 'USB-C Cable 1m', qty: 5, rate: 200, gstRate: 18 }] })
local.createVoucher('purchase_order', { date: '20260416', party: 'Zen Supplies', taxMode: 'inter', lines: [{ item: 'Wireless Mouse', qty: 20, rate: 400, gstRate: 18 }] })
local.createVoucher('purchase', { date: '20260418', party: 'Zen Supplies', taxMode: 'inter', lines: [{ item: 'USB-C Cable 1m', qty: 50, rate: 110, gstRate: 18 }] })
local.createVoucher('receipt', { date: '20260420', party: 'Acme Retail Pvt Ltd', cashLedger: 'HDFC Bank', amount: 1000, reference: si.voucher_number })
local.createVoucher('payment', { date: '20260421', party: 'Zen Supplies', cashLedger: 'HDFC Bank', amount: 500 })
push = await pushPending()
assert.equal(push.failed, 0, JSON.stringify(push.results))
assert.equal(push.synced, 5)
ok('sales order, purchase order, purchase, receipt, payment pushed')

// 3. pull
let pull = await pullAll()
assert.ok(pull.every((r) => !r.error), JSON.stringify(pull))
const vchCount = one<{ n: number }>('SELECT COUNT(*) n FROM t_vouchers').n
assert.equal(vchCount, 6)
ok(`pulled: ${pull.map((r) => `${r.objectType}=${r.objects}`).join(', ')}`)

const sales = q.tallyVouchers('Sales') as any[]
assert.equal(sales.length, 1)
assert.equal(sales[0].voucher_number, si.voucher_number)
assert.equal(sales[0].amount, 4484)
const lines = q.tallyVoucher(sales[0].guid)
assert.equal(lines.inventoryEntries.length, 2)
ok(`sales visible from Tally: ${sales[0].voucher_number} party=${sales[0].party} amount=${sales[0].amount}, ${lines.ledgerEntries.length} ledger + ${lines.inventoryEntries.length} inventory lines`)

const usbClosing = one<any>("SELECT * FROM t_stock_summary WHERE item='USB-C Cable 1m' AND source='tally_closing'")
assert.equal(usbClosing.qty, 140) // 100 opening - 10 sold + 50 purchased (orders ignored)
const mouseWh = one<any>("SELECT * FROM t_stock_summary WHERE item='Wireless Mouse' AND godown='Warehouse A' AND source='computed'")
assert.equal(mouseWh.qty, 38)
ok(`stock: USB-C closing ${usbClosing.qty} (value ${usbClosing.value}); Wireless Mouse @ Warehouse A ${mouseWh.qty}`)

const acme = one<any>("SELECT * FROM t_masters WHERE object_type='ledger' AND name='Acme Retail Pvt Ltd'")
assert.equal(acme.closing_balance, -3484) // Dr 4484 - receipt 1000
assert.equal(acme.gstin, '29ABCDE1234F1Z5')
ok(`ledger Acme closing ${acme.closing_balance} (Dr), GSTIN ${acme.gstin}`)

const raw = one<any>("SELECT raw_xml, raw_json FROM tally_objects WHERE object_type='voucher' AND name=?", `Sales/${si.voucher_number}`)
assert.match(raw.raw_xml, /^<VOUCHER /)
assert.ok(JSON.parse(raw.raw_json)['ALLINVENTORYENTRIES.LIST'].length === 2)
const fields = one<{ n: number }>('SELECT COUNT(*) n FROM schema_fields').n
const gdPath = one<any>("SELECT * FROM schema_fields WHERE object_type='voucher' AND path='ALLINVENTORYENTRIES.LIST[].BATCHALLOCATIONS.LIST[].GODOWNNAME'")
assert.ok(fields > 150 && gdPath, `fields=${fields}`)
ok(`raw_xml/raw_json stored; schema explorer has ${fields} field paths across ${(q.schemaTypes() as any[]).length} object types`)

const map = one<any>("SELECT * FROM tally_map WHERE entity='voucher' AND local_id=?", si.id)
assert.ok(map.guid && map.masterid)
ok(`mapping local voucher #${si.id} <-> Tally GUID ${map.guid} MASTERID ${map.masterid}`)

// 4. idempotency
const before = getMockTally().state.objects.filter((o) => o.tag === 'VOUCHER').length
local.createVoucher('sales', { number: si.voucher_number, date: '20260415', party: 'Acme Retail Pvt Ltd', taxMode: 'intra', lines: [{ item: 'USB-C Cable 1m', qty: 12, rate: 200, gstRate: 18 }] })
push = await pushPending()
assert.equal(push.results[0]?.action, 'Alter', JSON.stringify(push.results))
assert.equal(getMockTally().state.objects.filter((o) => o.tag === 'VOUCHER').length, before)
ok('re-push of same voucher number => ACTION=Alter, no duplicate in Tally')

// 5. incremental pull
pull = await pullAll()
const vPull = pull.find((r) => r.objectType === 'voucher')!
assert.equal(vPull.objects, 1)
assert.equal(pull.find((r) => r.objectType === 'ledger')!.objects, 0)
assert.equal(one<any>("SELECT qty FROM t_stock_summary WHERE item='USB-C Cable 1m' AND source='tally_closing'").qty, 138)
ok(`incremental pull (ALTERID > ${vPull.since}) fetched only the altered voucher; stock now 138`)

// 6. Tally errors are captured
local.createVoucher('sales', { date: '20260422', party: 'Unknown Customer', taxMode: 'none', lines: [{ item: 'USB-C Cable 1m', qty: 1, rate: 10 }] })
push = await pushPending()
assert.equal(push.failed, 1)
assert.match(push.results[0].error ?? '', /Ledger 'Unknown Customer' does not exist/)
ok(`failed push recorded in outbox: "${push.results[0].error}"`)

const unbalanced = importEnvelope('Vouchers', config.company, [
  `<VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>20260423</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>X1</VOUCHERNUMBER>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>90.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`
])
const ur = parseImportResponse(getMockTally().handle(unbalanced))
assert.equal(ur.ok, false)
assert.match(ur.lineErrors[0], /do not match/)
ok(`unbalanced voucher rejected: "${ur.lineErrors[0]}"`)

// 7. real HTTP client path against mock server with UTF-16 response
const httpMock = new MockTally(null, 'Demo Sync Co')
const server = await startMockServer(httpMock, 0, { utf16: true })
const port = (server.address() as { port: number }).port
const client = new TallyClient('real', `http://127.0.0.1:${port}`, 5000)
const resp = await client.post(buildCollectionExport(OBJECTS.group, { company: 'Demo Sync Co' }))
const groups = extractElements(innerOf(resp, 'DATA'), 'GROUP')
assert.equal(groups.length, 28)
server.close()
ok(`HTTP client + UTF-16 decoding OK (${groups.length} reserved groups from mock server)`)

const bad = new TallyClient('real', 'http://127.0.0.1:1', 2000)
await assert.rejects(bad.post('<ENVELOPE/>'), /Cannot reach Tally/)
ok('unreachable Tally gives a clear error')

console.log(`\nALL ${step} CHECKS PASSED`)
