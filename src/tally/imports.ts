import { esc } from './xml.js'

export type MasterKind = 'group' | 'ledger' | 'unit' | 'stock_group' | 'godown' | 'stock_item'
export type VoucherKind = 'sales_order' | 'sales' | 'purchase_order' | 'purchase' | 'receipt' | 'payment'
export type ImportAction = 'Create' | 'Alter'

export const MASTER_TAG: Record<MasterKind, string> = {
  group: 'GROUP', ledger: 'LEDGER', unit: 'UNIT', stock_group: 'STOCKGROUP', godown: 'GODOWN', stock_item: 'STOCKITEM'
}

export const VOUCHER_TYPE_NAME: Record<VoucherKind, string> = {
  sales_order: 'Sales Order', sales: 'Sales', purchase_order: 'Purchase Order', purchase: 'Purchase', receipt: 'Receipt', payment: 'Payment'
}

export interface GroupInput { name: string; parent: string }
export interface LedgerInput {
  name: string
  parent: string
  openingBalance?: number // + = Debit, - = Credit (as accountants read it)
  gstin?: string
  state?: string
  address?: string
  billWise?: boolean
  gstDutyHead?: 'Central Tax' | 'State Tax' | 'Integrated Tax'
  gstRate?: number
  affectsStock?: boolean
}
export interface UnitInput { name: string; decimals?: number; formalName?: string }
export interface StockGroupInput { name: string; parent?: string }
export interface GodownInput { name: string; parent?: string }
export interface StockItemInput {
  name: string
  parent?: string
  baseUnit: string
  hsn?: string
  gstRate?: number
  openingQty?: number
  openingRate?: number
  godown?: string
}
export type MasterInput = GroupInput | LedgerInput | UnitInput | StockGroupInput | GodownInput | StockItemInput

export interface VoucherLine { item: string; qty: number; rate: number; godown?: string; unit?: string; gstRate?: number }
export interface VoucherInput {
  kind: VoucherKind
  number: string
  date: string // YYYYMMDD
  party: string
  lines?: VoucherLine[]
  account?: string // Sales / Purchase ledger
  taxMode?: 'intra' | 'inter' | 'none'
  taxLedgers?: { cgst: string; sgst: string; igst: string }
  cashLedger?: string // receipt/payment: Cash or bank ledger
  amount?: number // receipt/payment
  narration?: string
  reference?: string
  dueDate?: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const amt = (n: number) => r2(n).toFixed(2)
const qtyStr = (q: number, unit: string) => ` ${q} ${unit}`

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
export function importEnvelope(reportName: 'All Masters' | 'Vouchers', company: string, messages: string[]): string {
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${reportName}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${messages.map((m) => `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n${m}\n        </TALLYMESSAGE>`).join('\n')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`
}

const nameList = (name: string) => `<NAME.LIST TYPE="String"><NAME>${esc(name)}</NAME></NAME.LIST>`

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------
export function buildMasterXml(kind: MasterKind, d: MasterInput, action: ImportAction): string {
  switch (kind) {
    case 'group': {
      const g = d as GroupInput
      return `<GROUP NAME="${esc(g.name)}" ACTION="${action}">${nameList(g.name)}<PARENT>${esc(g.parent)}</PARENT><ISSUBLEDGER>No</ISSUBLEDGER><AFFECTSGROSSPROFIT>No</AFFECTSGROSSPROFIT></GROUP>`
    }
    case 'ledger': {
      const l = d as LedgerInput
      const parts = [
        `<LEDGER NAME="${esc(l.name)}" ACTION="${action}">`,
        nameList(l.name),
        `<PARENT>${esc(l.parent)}</PARENT>`,
        `<ISBILLWISEON>${l.billWise ? 'Yes' : 'No'}</ISBILLWISEON>`,
        // Tally XML: debit balances are negative
        `<OPENINGBALANCE>${amt(-(l.openingBalance ?? 0))}</OPENINGBALANCE>`
      ]
      if (l.affectsStock) parts.push('<AFFECTSSTOCK>Yes</AFFECTSSTOCK>')
      if (l.address || l.state || l.gstin) {
        // Legacy (TallyPrime <= 2.x / ERP 9) fields
        if (l.address) parts.push(`<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(l.address)}</ADDRESS></ADDRESS.LIST>`)
        if (l.state) parts.push(`<LEDSTATENAME>${esc(l.state)}</LEDSTATENAME><COUNTRYNAME>India</COUNTRYNAME>`)
        if (l.gstin) parts.push(`<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><PARTYGSTIN>${esc(l.gstin)}</PARTYGSTIN>`)
        // TallyPrime 3.x+/4.x+ dated sub-lists (ignored by older releases)
        parts.push(
          `<LEDMAILINGDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><MAILINGNAME>${esc(l.name)}</MAILINGNAME>` +
            (l.address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(l.address)}</ADDRESS></ADDRESS.LIST>` : '') +
            (l.state ? `<STATE>${esc(l.state)}</STATE>` : '') +
            `<COUNTRY>India</COUNTRY></LEDMAILINGDETAILS.LIST>`
        )
        if (l.gstin)
          parts.push(
            `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` +
              (l.state ? `<PLACEOFSUPPLY>${esc(l.state)}</PLACEOFSUPPLY>` : '') +
              `<GSTIN>${esc(l.gstin)}</GSTIN></LEDGSTREGDETAILS.LIST>`
          )
      }
      if (l.gstDutyHead) {
        parts.push(`<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${esc(l.gstDutyHead)}</GSTDUTYHEAD>`)
        if (l.gstRate) parts.push(`<RATEOFTAXCALCULATION>${l.gstRate}</RATEOFTAXCALCULATION>`)
      }
      parts.push('</LEDGER>')
      return parts.join('')
    }
    case 'unit': {
      const u = d as UnitInput
      return `<UNIT NAME="${esc(u.name)}" ACTION="${action}"><NAME>${esc(u.name)}</NAME><ORIGINALNAME>${esc(u.formalName ?? u.name)}</ORIGINALNAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>${u.decimals ?? 0}</DECIMALPLACES></UNIT>`
    }
    case 'stock_group': {
      const g = d as StockGroupInput
      return `<STOCKGROUP NAME="${esc(g.name)}" ACTION="${action}">${nameList(g.name)}<PARENT>${esc(g.parent ?? '')}</PARENT><ISADDABLE>Yes</ISADDABLE></STOCKGROUP>`
    }
    case 'godown': {
      const g = d as GodownInput
      return `<GODOWN NAME="${esc(g.name)}" ACTION="${action}">${nameList(g.name)}<PARENT>${esc(g.parent ?? '')}</PARENT></GODOWN>`
    }
    case 'stock_item': {
      const s = d as StockItemInput
      const q = s.openingQty ?? 0
      const rate = s.openingRate ?? 0
      const value = r2(q * rate)
      const godown = s.godown || 'Main Location'
      const parts = [
        `<STOCKITEM NAME="${esc(s.name)}" ACTION="${action}">`,
        nameList(s.name),
        `<PARENT>${esc(s.parent ?? '')}</PARENT>`,
        `<BASEUNITS>${esc(s.baseUnit)}</BASEUNITS>`,
        `<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>`,
        `<GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>`
      ]
      if (q) {
        // Stock opening value is a debit -> negative in Tally XML
        parts.push(
          `<OPENINGBALANCE>${qtyStr(q, s.baseUnit)}</OPENINGBALANCE><OPENINGVALUE>${amt(-value)}</OPENINGVALUE><OPENINGRATE>${amt(rate)}/${esc(s.baseUnit)}</OPENINGRATE>`,
          `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE>${qtyStr(q, s.baseUnit)}</OPENINGBALANCE><OPENINGVALUE>${amt(-value)}</OPENINGVALUE><OPENINGRATE>${amt(rate)}/${esc(s.baseUnit)}</OPENINGRATE></BATCHALLOCATIONS.LIST>`
        )
      }
      if (s.gstRate !== undefined || s.hsn) {
        const rate = s.gstRate ?? 0
        parts.push(
          `<GSTDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><CALCULATIONTYPE>On Value</CALCULATIONTYPE><HSNCODE>${esc(s.hsn ?? '')}</HSNCODE><TAXABILITY>Taxable</TAXABILITY>` +
            `<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>` +
            `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${rate / 2}</GSTRATE></RATEDETAILS.LIST>` +
            `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${rate / 2}</GSTRATE></RATEDETAILS.LIST>` +
            `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${rate}</GSTRATE></RATEDETAILS.LIST>` +
            `</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`
        )
      }
      parts.push('</STOCKITEM>')
      return parts.join('')
    }
  }
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------
export interface VoucherTotals {
  lines: Array<VoucherLine & { amount: number }>
  taxable: number
  cgst: number
  sgst: number
  igst: number
  total: number
}

export function computeTotals(v: VoucherInput): VoucherTotals {
  if (v.kind === 'receipt' || v.kind === 'payment') {
    const total = r2(v.amount ?? 0)
    return { lines: [], taxable: total, cgst: 0, sgst: 0, igst: 0, total }
  }
  const lines = (v.lines ?? []).map((l) => ({ ...l, amount: r2(l.qty * l.rate) }))
  const taxable = r2(lines.reduce((s, l) => s + l.amount, 0))
  let cgst = 0, sgst = 0, igst = 0
  for (const l of lines) {
    const rate = l.gstRate ?? 0
    if (v.taxMode === 'intra') { cgst += (l.amount * rate) / 200; sgst += (l.amount * rate) / 200 }
    else if (v.taxMode === 'inter') igst += (l.amount * rate) / 100
  }
  cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst)
  return { lines, taxable, cgst, sgst, igst, total: r2(taxable + cgst + sgst + igst) }
}

function ledgerEntry(ledger: string, deemedPositive: boolean, amount: number, extra = '') {
  return `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(amount)}</AMOUNT>${extra}</LEDGERENTRIES.LIST>`
}

/**
 * Build a voucher. Sign convention in Tally XML: Debit = negative AMOUNT + ISDEEMEDPOSITIVE=Yes,
 * Credit = positive AMOUNT + ISDEEMEDPOSITIVE=No. All entries must sum to exactly 0.
 */
export function buildVoucherXml(v: VoucherInput, action: ImportAction): string {
  const vchType = VOUCHER_TYPE_NAME[v.kind]
  const t = computeTotals(v)
  const isOrder = v.kind === 'sales_order' || v.kind === 'purchase_order'
  const isSaleSide = v.kind === 'sales' || v.kind === 'sales_order'
  const isInventory = v.kind !== 'receipt' && v.kind !== 'payment'
  const view = isInventory ? 'Invoice Voucher View' : 'Accounting Voucher View'
  const attrs =
    action === 'Alter'
      ? `DATE="${v.date}" TAGNAME="Voucher Number" TAGVALUE="${esc(v.number)}" VCHTYPE="${vchType}" ACTION="Alter" OBJVIEW="${view}"`
      : `VCHTYPE="${vchType}" ACTION="Create" OBJVIEW="${view}"`
  const head = [
    `<VOUCHER ${attrs}>`,
    `<DATE>${v.date}</DATE>`,
    `<EFFECTIVEDATE>${v.date}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>`,
    `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>`,
    `<REFERENCE>${esc(v.reference ?? v.number)}</REFERENCE>`,
    `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>`,
    `<PARTYNAME>${esc(v.party)}</PARTYNAME>`,
    `<BASICBASEPARTYNAME>${esc(v.party)}</BASICBASEPARTYNAME>`,
    `<PERSISTEDVIEW>${view}</PERSISTEDVIEW>`,
    `<NARRATION>${esc(v.narration ?? `Created by tallytesting demo [${v.number}]`)}</NARRATION>`
  ]
  const body: string[] = []

  if (isInventory) {
    head.push(`<ISINVOICE>${isOrder ? 'No' : 'Yes'}</ISINVOICE>`)
    if (isOrder) head.push(`<BASICORDERREF>${esc(v.number)}</BASICORDERREF>`)
    const account = v.account ?? (isSaleSide ? 'Sales' : 'Purchase')
    // sale side: stock goes out (credit, positive); purchase side: stock comes in (debit, negative)
    const sign = isSaleSide ? 1 : -1
    const deemed = !isSaleSide
    for (const l of t.lines) {
      const unit = l.unit ?? 'Nos'
      const godown = l.godown || 'Main Location'
      const orderBits = isOrder
        ? `<ORDERNO>${esc(v.number)}</ORDERNO><ORDERDUEDATE P="${v.dueDate ?? v.date}">${v.dueDate ?? v.date}</ORDERDUEDATE>`
        : ''
      body.push(
        `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${esc(l.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${deemed ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
          `<RATE>${amt(l.rate)}/${esc(unit)}</RATE><AMOUNT>${amt(sign * l.amount)}</AMOUNT><ACTUALQTY>${qtyStr(l.qty, unit)}</ACTUALQTY><BILLEDQTY>${qtyStr(l.qty, unit)}</BILLEDQTY>` +
          `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME>${orderBits}<AMOUNT>${amt(sign * l.amount)}</AMOUNT><ACTUALQTY>${qtyStr(l.qty, unit)}</ACTUALQTY><BILLEDQTY>${qtyStr(l.qty, unit)}</BILLEDQTY></BATCHALLOCATIONS.LIST>` +
          `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${esc(account)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(sign * l.amount)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` +
          `</ALLINVENTORYENTRIES.LIST>`
      )
    }
    const bill = isOrder
      ? ''
      : `<BILLALLOCATIONS.LIST><NAME>${esc(v.number)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>${amt(-sign * t.total)}</AMOUNT></BILLALLOCATIONS.LIST>`
    // party: sale = debit (negative), purchase = credit (positive)
    body.push(ledgerEntry(v.party, isSaleSide, -sign * t.total, `<ISPARTYLEDGER>Yes</ISPARTYLEDGER>${bill}`))
    const tl = v.taxLedgers ?? { cgst: 'CGST', sgst: 'SGST', igst: 'IGST' }
    if (t.cgst) body.push(ledgerEntry(tl.cgst, deemed, sign * t.cgst))
    if (t.sgst) body.push(ledgerEntry(tl.sgst, deemed, sign * t.sgst))
    if (t.igst) body.push(ledgerEntry(tl.igst, deemed, sign * t.igst))
  } else {
    const cash = v.cashLedger ?? 'Cash'
    const receipt = v.kind === 'receipt'
    // Receipt: party credit (+), cash debit (-). Payment: party debit (-), cash credit (+)
    const partySign = receipt ? 1 : -1
    body.push(
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(v.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>${receipt ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>${amt(partySign * t.total)}</AMOUNT>` +
        `<BILLALLOCATIONS.LIST><NAME>${esc(v.reference ?? v.number)}</NAME><BILLTYPE>${v.reference ? 'Agst Ref' : 'On Account'}</BILLTYPE><AMOUNT>${amt(partySign * t.total)}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>`,
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(cash)}</LEDGERNAME><ISDEEMEDPOSITIVE>${receipt ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(-partySign * t.total)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
    )
  }
  return [...head, ...body, '</VOUCHER>'].join('')
}
