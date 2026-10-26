/**
 * Generates windows/requests/*.xml from the SAME builders the app uses, so the PowerShell script
 * tests exactly what the app sends. Placeholders: __COMPANY__, __DATE__, __FROM__, __TO__.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OBJECTS, PULL_ORDER, buildCollectionExport, buildLookup, tdlString } from '../src/tally/exports.js'
import { buildMasterXml, buildVoucherXml, importEnvelope, type VoucherInput } from '../src/tally/imports.js'

const dir = path.resolve(import.meta.dirname, '..', 'windows', 'requests')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })
const C = '__COMPANY__'
const files: Record<string, string> = {}

files['00-list-companies.xml'] = buildCollectionExport(OBJECTS.company, { company: C })
files['01-create-masters.xml'] = importEnvelope('All Masters', C, [
  buildMasterXml('unit', { name: 'Nos', formalName: 'Numbers', decimals: 0 }, 'Create'),
  buildMasterXml('godown', { name: 'TT Test Godown' }, 'Create'),
  buildMasterXml('stock_group', { name: 'TT Test Stock Group' }, 'Create'),
  buildMasterXml('group', { name: 'TT Test Customers', parent: 'Sundry Debtors' }, 'Create'),
  buildMasterXml('ledger', { name: 'TT Test Sales', parent: 'Sales Accounts', affectsStock: true }, 'Create'),
  buildMasterXml('ledger', { name: 'TT Test CGST', parent: 'Duties & Taxes', gstDutyHead: 'Central Tax', gstRate: 9 }, 'Create'),
  buildMasterXml('ledger', { name: 'TT Test SGST', parent: 'Duties & Taxes', gstDutyHead: 'State Tax', gstRate: 9 }, 'Create'),
  buildMasterXml('ledger', { name: 'TT Test IGST', parent: 'Duties & Taxes', gstDutyHead: 'Integrated Tax', gstRate: 18 }, 'Create'),
  buildMasterXml('ledger', { name: 'TT Test Customer', parent: 'TT Test Customers', billWise: true, gstin: '29ABCDE1234F1Z5', state: 'Karnataka', address: 'MG Road, Bengaluru' }, 'Create'),
  buildMasterXml('stock_item', { name: 'TT Test Item', parent: 'TT Test Stock Group', baseUnit: 'Nos', hsn: '85444299', gstRate: 18, openingQty: 100, openingRate: 50, godown: 'TT Test Godown' }, 'Create')
])
const sale: VoucherInput = {
  kind: 'sales', number: 'TT/TEST/0001', date: '__DATE__', party: 'TT Test Customer', account: 'TT Test Sales', taxMode: 'intra',
  taxLedgers: { cgst: 'TT Test CGST', sgst: 'TT Test SGST', igst: 'TT Test IGST' },
  lines: [{ item: 'TT Test Item', qty: 3, rate: 100, gstRate: 18, godown: 'TT Test Godown' }]
}
files['02-create-sales-invoice.xml'] = importEnvelope('Vouchers', C, [buildVoucherXml(sale, 'Create')])
files['03-lookup-sales-invoice.xml'] = buildLookup(OBJECTS.voucher, C, `$VoucherNumber = ${tdlString(sale.number)} AND $VoucherTypeName = "Sales"`, { from: '__FROM__', to: '__TO__' })
files['04-alter-sales-invoice.xml'] = importEnvelope('Vouchers', C, [buildVoucherXml({ ...sale, lines: [{ ...sale.lines![0], qty: 4 }] }, 'Alter')])
files['05-create-sales-order.xml'] = importEnvelope('Vouchers', C, [buildVoucherXml({ ...sale, kind: 'sales_order', number: 'TT/TEST/SO1', dueDate: '__DATE__' }, 'Create')])
files['06-create-receipt.xml'] = importEnvelope('Vouchers', C, [buildVoucherXml({ kind: 'receipt', number: 'TT/TEST/RC1', date: '__DATE__', party: 'TT Test Customer', cashLedger: 'Cash', amount: 100, reference: 'TT/TEST/0001' }, 'Create')])
files['07-unbalanced-voucher-expect-error.xml'] = importEnvelope('Vouchers', C, [
  buildVoucherXml({ kind: 'receipt', number: 'TT/TEST/BAD', date: '__DATE__', party: 'TT Test Customer', cashLedger: 'Cash', amount: 100 }, 'Create')
    .replace('<AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>', '<AMOUNT>-90.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>')
])
let i = 10
for (const key of PULL_ORDER) {
  files[`${i++}-export-${key}-full.xml`] = buildCollectionExport(OBJECTS[key], { company: C, fromDate: '__FROM__', toDate: '__TO__' })
}
files[`${i++}-export-voucher-incremental-alterid-gt-0.xml`] = buildCollectionExport(OBJECTS.voucher, { company: C, sinceAlterId: 1, fromDate: '__FROM__', toDate: '__TO__' })
files[`${i++}-balances-stock-items.xml`] = buildCollectionExport(OBJECTS.stock_item, { company: C, fetch: ['GUID', 'Name', 'ClosingBalance', 'ClosingValue', 'ClosingRate'] })

for (const [name, xml] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), xml + '\n')
console.log(`wrote ${Object.keys(files).length} request files to ${dir}`)
