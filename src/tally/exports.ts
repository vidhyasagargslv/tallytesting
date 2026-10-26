import { esc } from './xml.js'

/**
 * Everything we pull from Tally. Each uses a TDL Collection export with
 * NATIVEMETHOD * and FETCH * so Tally returns the FULL object (all fields), not a report subset.
 */
export type ObjectKey =
  | 'company' | 'group' | 'ledger' | 'unit' | 'stock_group' | 'stock_item' | 'godown' | 'voucher_type' | 'voucher'

export interface ObjectDef {
  key: ObjectKey
  tdlType: string // Collection <TYPE>
  tag: string // element name in the export XML
  incremental: boolean // supports $AlterID filter
  extraFetch: string[] // sub-collections / computed methods to fetch explicitly
  dated?: boolean // needs SVFROMDATE/SVTODATE
}

export const OBJECTS: Record<ObjectKey, ObjectDef> = {
  company: { key: 'company', tdlType: 'Company', tag: 'COMPANY', incremental: false, extraFetch: [] },
  group: { key: 'group', tdlType: 'Group', tag: 'GROUP', incremental: true, extraFetch: [] },
  ledger: {
    key: 'ledger', tdlType: 'Ledger', tag: 'LEDGER', incremental: true,
    extraFetch: ['OpeningBalance', 'ClosingBalance', 'LedgerMailingDetails', 'LedGSTRegDetails', 'Address']
  },
  unit: { key: 'unit', tdlType: 'Unit', tag: 'UNIT', incremental: true, extraFetch: [] },
  stock_group: { key: 'stock_group', tdlType: 'StockGroup', tag: 'STOCKGROUP', incremental: true, extraFetch: [] },
  stock_item: {
    key: 'stock_item', tdlType: 'StockItem', tag: 'STOCKITEM', incremental: true,
    extraFetch: ['OpeningBalance', 'OpeningValue', 'OpeningRate', 'ClosingBalance', 'ClosingValue', 'ClosingRate', 'BatchAllocations', 'GSTDetails']
  },
  godown: { key: 'godown', tdlType: 'Godown', tag: 'GODOWN', incremental: true, extraFetch: [] },
  voucher_type: { key: 'voucher_type', tdlType: 'VoucherType', tag: 'VOUCHERTYPE', incremental: true, extraFetch: [] },
  voucher: {
    key: 'voucher', tdlType: 'Voucher', tag: 'VOUCHER', incremental: true, dated: true,
    extraFetch: ['AllLedgerEntries', 'LedgerEntries', 'AllInventoryEntries', 'InventoryEntries', 'AllLedgerEntries.BillAllocations', 'AllInventoryEntries.BatchAllocations', 'AllInventoryEntries.AccountingAllocations']
  }
}

/** Pull order: masters before vouchers. */
export const PULL_ORDER: ObjectKey[] = ['company', 'group', 'ledger', 'unit', 'stock_group', 'godown', 'stock_item', 'voucher_type', 'voucher']

export interface ExportOptions {
  company: string
  sinceAlterId?: number
  fromDate?: string
  toDate?: string
  filter?: string // extra TDL boolean expression
  fetch?: string[] // override: fetch only these (used for lookups)
}

export function collectionName(def: ObjectDef) {
  return `TT ${def.tdlType} Export`
}

export function buildCollectionExport(def: ObjectDef, o: ExportOptions): string {
  const name = collectionName(def)
  const conditions: string[] = []
  if (def.incremental && o.sinceAlterId && o.sinceAlterId > 0) conditions.push(`$AlterID > ${Math.floor(o.sinceAlterId)}`)
  if (o.filter) conditions.push(o.filter)
  const filterName = 'TTFilter'
  const filterXml = conditions.length
    ? `<FILTER>${filterName}</FILTER>`
    : ''
  const systemXml = conditions.length
    ? `<SYSTEM TYPE="Formulae" NAME="${filterName}">${esc(conditions.map((c) => `(${c})`).join(' AND '))}</SYSTEM>`
    : ''
  const fetchList = o.fetch ?? ['*', ...def.extraFetch]
  const nativeXml = o.fetch ? '' : '<NATIVEMETHOD>*</NATIVEMETHOD>'
  const dates = def.dated || o.fromDate
    ? `<SVFROMDATE TYPE="Date">${o.fromDate ?? ''}</SVFROMDATE><SVTODATE TYPE="Date">${o.toDate ?? ''}</SVTODATE>`
    : ''
  const companyXml = def.key === 'company' ? '' : `<SVCURRENTCOMPANY>${esc(o.company)}</SVCURRENTCOMPANY>`
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${esc(name)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${companyXml}
        ${dates}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${esc(name)}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
            <TYPE>${def.tdlType}</TYPE>
            ${nativeXml}
            ${fetchList.map((f) => `<FETCH>${esc(f)}</FETCH>`).join('\n            ')}
            ${filterXml}
          </COLLECTION>
          ${systemXml}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`
}

/** Small export used before a push to find whether an object already exists (idempotency). */
export function buildLookup(def: ObjectDef, company: string, filter: string, dates?: { from: string; to: string }): string {
  return buildCollectionExport(def, {
    company,
    filter,
    fetch: ['GUID', 'MasterID', 'AlterID', 'Name', 'VoucherNumber', 'VoucherTypeName', 'Date'],
    fromDate: dates?.from,
    toDate: dates?.to
  })
}

export function tdlString(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}
