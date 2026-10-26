/**
 * In-process simulated TallyPrime XML server.
 *
 * - Accepts the same XML envelopes the real client sends (Import Data / Export Collection).
 * - Validates imports like Tally does (missing parent/ledger/item/godown/unit, unbalanced vouchers,
 *   duplicate masters) and answers with CREATED/ALTERED/ERRORS/LINEERROR.
 * - Keeps state (objects, GUID, MASTERID, ALTERID) in a JSON file so pulls return what was pushed.
 * - Export output mimics real TallyPrime collection XML shapes (see /Users/vidhya/Office/tally samples):
 *   CMPINFO header, <COLLECTION> with <LEDGER NAME=".." RESERVEDNAME="">, LANGUAGENAME.LIST, TYPE attrs,
 *   computed CLOSINGBALANCE / CLOSINGVALUE, voucher REMOTEID/VCHKEY attributes.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { buildMasterXml } from '../tally/imports.js'
import { asArray, esc, firstTagText, innerOf, num, parseXml, text } from '../tally/xml.js'

interface MockObj {
  tag: string
  name: string
  guid: string
  masterid: number
  alterid: number
  xml: string
  vchType?: string
  vchNumber?: string
  date?: string
  reserved?: string
}

interface MockState {
  companyName: string
  companyGuid: string
  seq: number // AlterID counter
  mid: number // MasterID counter
  objects: MockObj[]
}

const TYPE_TO_TAG: Record<string, string> = {
  group: 'GROUP', ledger: 'LEDGER', unit: 'UNIT', stockgroup: 'STOCKGROUP', godown: 'GODOWN',
  stockitem: 'STOCKITEM', vouchertype: 'VOUCHERTYPE', voucher: 'VOUCHER', company: 'COMPANY'
}
const LABEL: Record<string, string> = {
  GROUP: 'Group', LEDGER: 'Ledger', UNIT: 'Unit', STOCKGROUP: 'Stock Group', GODOWN: 'Godown', STOCKITEM: 'Stock Item', VOUCHERTYPE: 'Voucher Type'
}
const ORDER_TYPES = new Set(['Sales Order', 'Purchase Order'])
const IMPORT_TAGS = ['GROUP', 'LEDGER', 'UNIT', 'STOCKGROUP', 'GODOWN', 'STOCKITEM', 'VOUCHERTYPE', 'VOUCHER']

const RESERVED_GROUPS: Array<[string, string]> = [
  ['Capital Account', ''], ['Loans (Liability)', ''], ['Current Liabilities', ''], ['Fixed Assets', ''], ['Investments', ''],
  ['Current Assets', ''], ['Branch / Divisions', ''], ['Misc. Expenses (ASSET)', ''], ['Suspense A/c', ''],
  ['Sales Accounts', ''], ['Purchase Accounts', ''], ['Direct Incomes', ''], ['Direct Expenses', ''], ['Indirect Incomes', ''], ['Indirect Expenses', ''],
  ['Reserves & Surplus', 'Capital Account'], ['Bank OD A/c', 'Loans (Liability)'], ['Secured Loans', 'Loans (Liability)'], ['Unsecured Loans', 'Loans (Liability)'],
  ['Duties & Taxes', 'Current Liabilities'], ['Provisions', 'Current Liabilities'], ['Sundry Creditors', 'Current Liabilities'],
  ['Bank Accounts', 'Current Assets'], ['Cash-in-Hand', 'Current Assets'], ['Deposits (Asset)', 'Current Assets'],
  ['Loans & Advances (Asset)', 'Current Assets'], ['Stock-in-Hand', 'Current Assets'], ['Sundry Debtors', 'Current Assets']
]
const RESERVED_VCH_TYPES = [
  'Attendance', 'Contra', 'Credit Note', 'Debit Note', 'Delivery Note', 'Job Work In Order', 'Job Work Out Order', 'Journal',
  'Material In', 'Material Out', 'Memorandum', 'Payment', 'Payroll', 'Physical Stock', 'Purchase', 'Purchase Order',
  'Receipt', 'Receipt Note', 'Rejections In', 'Rejections Out', 'Reversing Journal', 'Sales', 'Sales Order', 'Stock Journal'
]

const r2 = (n: number) => Math.round(n * 100) / 100
const f2 = (n: number) => r2(n).toFixed(2)

export class MockTally {
  state: MockState

  constructor(private file: string | null, companyName = config.company) {
    if (file && fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf8'))
    else {
      this.state = { companyName, companyGuid: crypto.randomUUID(), seq: 0, mid: 0, objects: [] }
      this.seed()
      this.save()
    }
  }

  private save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1))
  }

  private seed() {
    for (const [name, parent] of RESERVED_GROUPS)
      this.add('GROUP', name, buildMasterXml('group', { name, parent }, 'Create'), name)
    this.add('LEDGER', 'Cash', buildMasterXml('ledger', { name: 'Cash', parent: 'Cash-in-Hand' }, 'Create'), 'Cash')
    this.add('LEDGER', 'Profit & Loss A/c', buildMasterXml('ledger', { name: 'Profit & Loss A/c', parent: '' }, 'Create'), 'Profit & Loss A/c')
    this.add('GODOWN', 'Main Location', buildMasterXml('godown', { name: 'Main Location' }, 'Create'), 'Main Location')
    for (const v of RESERVED_VCH_TYPES) {
      const xml = `<VOUCHERTYPE NAME="${esc(v)}"><NAME.LIST TYPE="String"><NAME>${esc(v)}</NAME></NAME.LIST><PARENT>${esc(v)}</PARENT><NUMBERINGMETHOD>Automatic (Manual Override)</NUMBERINGMETHOD><ISACTIVE>Yes</ISACTIVE><PREVENTDUPLICATES>No</PREVENTDUPLICATES><ISOPTIONAL>No</ISOPTIONAL></VOUCHERTYPE>`
      this.add('VOUCHERTYPE', v, xml, v)
    }
  }

  private guid(mid: number) {
    return `${this.state.companyGuid}-${mid.toString(16).padStart(8, '0')}`
  }

  private add(tag: string, name: string, xml: string, reserved?: string, extra: Partial<MockObj> = {}): MockObj {
    const masterid = ++this.state.mid
    const obj: MockObj = { tag, name, guid: this.guid(masterid), masterid, alterid: ++this.state.seq, xml, reserved, ...extra }
    this.state.objects.push(obj)
    return obj
  }

  private find(tag: string, name: string) {
    const n = name.trim().toLowerCase()
    return this.state.objects.find((o) => o.tag === tag && o.name.toLowerCase() === n)
  }

  // -------------------------------------------------------------------------
  handle(xml: string): string {
    const req = (firstTagText(xml, 'TALLYREQUEST') ?? '').toLowerCase()
    try {
      if (req.startsWith('import')) return this.doImport(xml)
      if (req === 'export') {
        const type = firstTagText(innerOf(xml, 'HEADER'), 'TYPE') ?? ''
        if (type.toLowerCase() === 'collection') return this.doExport(xml)
        const id = firstTagText(xml, 'ID') ?? ''
        return errorEnvelope(`Could not find Report '${id}'!`)
      }
      return errorEnvelope('Unknown Request, cannot be processed')
    } finally {
      this.save()
    }
  }

  private companyMismatch(xml: string): string | undefined {
    const company = firstTagText(xml, 'SVCURRENTCOMPANY')
    if (company && decode(company).toLowerCase() !== this.state.companyName.toLowerCase())
      return `Could not set 'SVCurrentCompany' to '${decode(company)}'`
    return undefined
  }

  // ------------------------------- IMPORT ---------------------------------
  private doImport(xml: string): string {
    const counts = { created: 0, altered: 0, errors: 0, lastVchId: 0, lastMid: 0 }
    const lineErrors: string[] = []
    const mismatch = this.companyMismatch(xml)
    if (mismatch) return importResponse({ ...counts, errors: 1 }, [mismatch])

    const data = innerOf(xml, 'REQUESTDATA')
    const re = new RegExp(`<(${IMPORT_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g')
    for (const m of data.matchAll(re)) {
      const tag = m[1]
      const el = m[0]
      const obj = parseXml(el)[tag]
      const result = tag === 'VOUCHER' ? this.importVoucher(el, obj) : this.importMaster(tag, el, obj)
      if (result.error) {
        counts.errors++
        lineErrors.push(result.error)
      } else {
        if (result.created) counts.created++
        else counts.altered++
        if (tag === 'VOUCHER') counts.lastVchId = result.obj!.masterid
        else counts.lastMid = result.obj!.masterid
      }
    }
    return importResponse(counts, lineErrors)
  }

  private importMaster(tag: string, el: string, o: any): { error?: string; created?: boolean; obj?: MockObj } {
    const action = String(o['@ACTION'] ?? 'Create').toLowerCase()
    const name = String(o['@NAME'] ?? text(o.NAME) ?? '').trim()
    const label = LABEL[tag]
    if (!name) return { error: `${label} name is blank` }
    const parent = text(o.PARENT)
    const parentOk = (ptag: string) => !parent || parent === 'Primary' || !!this.find(ptag, parent)
    if (tag === 'GROUP' || tag === 'LEDGER') {
      if (tag === 'LEDGER' && !parent && name !== 'Profit & Loss A/c') return { error: `[LEDGER] ${name}: Group '' does not exist!` }
      if (!parentOk('GROUP')) return { error: `[${tag}] ${name}: Group '${parent}' does not exist!` }
    }
    if (tag === 'STOCKGROUP' && !parentOk('STOCKGROUP')) return { error: `[STOCKGROUP] ${name}: Stock Group '${parent}' does not exist!` }
    if (tag === 'GODOWN' && !parentOk('GODOWN')) return { error: `[GODOWN] ${name}: Godown '${parent}' does not exist!` }
    if (tag === 'STOCKITEM') {
      if (!parentOk('STOCKGROUP')) return { error: `[STOCKITEM] ${name}: Stock Group '${parent}' does not exist!` }
      const unit = text(o.BASEUNITS)
      if (unit && !this.find('UNIT', unit)) return { error: `[STOCKITEM] ${name}: Unit '${unit}' does not exist!` }
      for (const b of asArray(o['BATCHALLOCATIONS.LIST'])) {
        const g = text(b.GODOWNNAME)
        if (g && !this.find('GODOWN', g)) return { error: `[STOCKITEM] ${name}: Godown '${g}' does not exist!` }
      }
    }
    const existing = this.find(tag, name)
    if (action === 'create') {
      if (existing) return { error: `[${tag}] ${label} '${name}' already exists!` }
      return { created: true, obj: this.add(tag, name, el) }
    }
    if (action === 'alter') {
      if (!existing) return { error: `[${tag}] ${label} '${name}' does not exist!` }
      if (existing.reserved && tag === 'GROUP') return { error: `[GROUP] Cannot alter reserved Group '${name}'` }
      existing.xml = el
      existing.alterid = ++this.state.seq
      return { created: false, obj: existing }
    }
    return { error: `[${tag}] Unsupported ACTION '${action}'` }
  }

  private importVoucher(el: string, o: any): { error?: string; created?: boolean; obj?: MockObj } {
    const action = String(o['@ACTION'] ?? 'Create').toLowerCase()
    const vchType = String(o['@VCHTYPE'] ?? text(o.VOUCHERTYPENAME))
    const number = text(o.VOUCHERNUMBER)
    const date = text(o.DATE)
    const where = `[VOUCHER] ${vchType} No. ${number}`
    if (!this.find('VOUCHERTYPE', vchType)) return { error: `${where}: Voucher Type '${vchType}' does not exist!` }
    if (!/^\d{8}$/.test(date)) return { error: `${where}: Invalid Date '${date}'` }

    const ledgerAmounts: number[] = []
    const checkLedger = (e: any): string | undefined => {
      const l = text(e.LEDGERNAME)
      if (!this.find('LEDGER', l)) return `${where}: Ledger '${l}' does not exist!`
      ledgerAmounts.push(num(e.AMOUNT))
    }
    for (const key of ['LEDGERENTRIES.LIST', 'ALLLEDGERENTRIES.LIST']) {
      for (const e of asArray(o[key])) {
        const err = checkLedger(e)
        if (err) return { error: err }
      }
    }
    for (const key of ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST']) {
      for (const inv of asArray(o[key])) {
        const item = text(inv.STOCKITEMNAME)
        if (!this.find('STOCKITEM', item)) return { error: `${where}: Stock Item '${item}' does not exist!` }
        for (const b of asArray(inv['BATCHALLOCATIONS.LIST'])) {
          const g = text(b.GODOWNNAME)
          if (g && !this.find('GODOWN', g)) return { error: `${where}: Godown '${g}' does not exist!` }
        }
        for (const a of asArray(inv['ACCOUNTINGALLOCATIONS.LIST'])) {
          const err = checkLedger(a)
          if (err) return { error: err }
        }
      }
    }
    const diff = r2(ledgerAmounts.reduce((s, a) => s + a, 0))
    if (Math.abs(diff) > 0.009) {
      const dr = -ledgerAmounts.filter((a) => a < 0).reduce((s, a) => s + a, 0)
      const cr = ledgerAmounts.filter((a) => a > 0).reduce((s, a) => s + a, 0)
      return { error: `${where}: Voucher totals do not match! Dr: ${f2(dr)} Dr Cr: ${f2(cr)} Cr Diff.: ${f2(Math.abs(diff))}` }
    }

    if (action === 'alter') {
      const tagValue = String(o['@TAGVALUE'] ?? number)
      const existing = this.state.objects.find((x) => x.tag === 'VOUCHER' && x.vchType === vchType && x.vchNumber === tagValue)
      if (!existing) return { error: `${where}: Voucher does not exist for alteration (TAGVALUE '${tagValue}')` }
      existing.xml = el
      existing.date = date
      existing.alterid = ++this.state.seq
      return { created: false, obj: existing }
    }
    if (action !== 'create') return { error: `${where}: Unsupported ACTION '${action}'` }
    // NOTE: like real Tally (unless "Prevent duplicates" is on), duplicate voucher numbers are accepted.
    return { created: true, obj: this.add('VOUCHER', `${vchType}/${number}`, el, undefined, { vchType, vchNumber: number, date }) }
  }

  // ------------------------------- EXPORT ---------------------------------
  private doExport(xml: string): string {
    const coll = innerOf(xml, 'COLLECTION')
    const tdlType = (firstTagText(coll, 'TYPE') ?? '').replace(/\s+/g, '').toLowerCase()
    const tag = TYPE_TO_TAG[tdlType]
    if (!tag) return errorEnvelope(`Unknown collection type '${tdlType}'`)
    if (tag !== 'COMPANY') {
      const mismatch = this.companyMismatch(xml)
      if (mismatch) return errorEnvelope(mismatch)
    }
    // full object for FETCH * ; balance refresh (FETCH ClosingBalance) also needs computed fields
    const full = /<NATIVEMETHOD>\*<\/NATIVEMETHOD>/.test(coll) || /<FETCH>\*<\/FETCH>/.test(coll) || /<FETCH>Closing/i.test(coll)
    const filter = decode(firstTagText(xml, 'SYSTEM') ?? '')
    const since = Number(filter.match(/\$AlterID\s*>\s*(\d+)/i)?.[1] ?? 0)
    const nameEq = filter.match(/\$Name\s*=\s*"((?:[^"]|"")*)"/i)?.[1]?.replace(/""/g, '"')
    const vchNo = filter.match(/\$VoucherNumber\s*=\s*"((?:[^"]|"")*)"/i)?.[1]?.replace(/""/g, '"')
    const vchType = filter.match(/\$VoucherTypeName\s*=\s*"((?:[^"]|"")*)"/i)?.[1]?.replace(/""/g, '"')
    const from = firstTagText(xml, 'SVFROMDATE') || '00000000'
    const to = firstTagText(xml, 'SVTODATE') || '99999999'

    let body: string
    if (tag === 'COMPANY') body = this.renderCompany()
    else {
      let list = this.state.objects.filter((o) => o.tag === tag && o.alterid > since)
      if (nameEq !== undefined) list = list.filter((o) => o.name.toLowerCase() === nameEq.toLowerCase())
      if (tag === 'VOUCHER') {
        list = list.filter((o) => (o.date ?? '') >= from && (o.date ?? '') <= to)
        if (vchNo !== undefined) list = list.filter((o) => o.vchNumber === vchNo)
        if (vchType !== undefined) list = list.filter((o) => o.vchType === vchType)
      }
      const balances = full ? this.computeBalances() : undefined
      body = list.map((o) => (full ? this.renderFull(o, balances!) : this.renderLookup(o))).join('\n')
    }
    return exportEnvelope(body, this.cmpInfo())
  }

  private cmpInfo(): Record<string, number> {
    const c: Record<string, number> = {}
    for (const o of this.state.objects) c[o.tag] = (c[o.tag] ?? 0) + 1
    return c
  }

  private renderCompany(): string {
    const masters = this.state.objects.filter((o) => o.tag !== 'VOUCHER')
    const vch = this.state.objects.filter((o) => o.tag === 'VOUCHER')
    const maxAlt = (l: MockObj[]) => l.reduce((m, o) => Math.max(m, o.alterid), 0)
    const n = esc(this.state.companyName)
    return `    <COMPANY NAME="${n}" RESERVEDNAME="">
     <GUID TYPE="String">${this.state.companyGuid}</GUID>
     <STARTINGFROM TYPE="Date">${config.fromDate}</STARTINGFROM>
     <BOOKSFROM TYPE="Date">${config.fromDate}</BOOKSFROM>
     <ENDINGAT TYPE="Date">${config.toDate}</ENDINGAT>
     <BASICCOMPANYFORMALNAME TYPE="String">${n}</BASICCOMPANYFORMALNAME>
     <ADDRESS.LIST TYPE="String"><ADDRESS>12, Demo Street</ADDRESS><ADDRESS>Bengaluru</ADDRESS></ADDRESS.LIST>
     <STATENAME TYPE="String">Karnataka</STATENAME>
     <COUNTRYNAME TYPE="String">India</COUNTRYNAME>
     <PINCODE TYPE="String">560001</PINCODE>
     <EMAIL TYPE="String">accounts@demosync.example</EMAIL>
     <GSTREGISTRATIONNUMBER TYPE="String">29AAACD1234F1Z5</GSTREGISTRATIONNUMBER>
     <INCOMETAXNUMBER TYPE="String">AAACD1234F</INCOMETAXNUMBER>
     <CURRENCYNAME TYPE="String">₹</CURRENCYNAME>
     <ISINVENTORYON TYPE="Logical">Yes</ISINVENTORYON>
     <ISINTEGRATED TYPE="Logical">Yes</ISINTEGRATED>
     <ISBILLWISEON TYPE="Logical">Yes</ISBILLWISEON>
     <ISGSTON TYPE="Logical">Yes</ISGSTON>
     <ISSECURITYON TYPE="Logical">No</ISSECURITYON>
     <MASTERID TYPE="Number"> 1</MASTERID>
     <ALTERID TYPE="Number"> ${this.state.seq}</ALTERID>
     <ALTMSTID TYPE="Number"> ${maxAlt(masters)}</ALTMSTID>
     <ALTVCHID TYPE="Number"> ${maxAlt(vch)}</ALTVCHID>
     <LASTVOUCHERDATE TYPE="Date">${vch.reduce((m, o) => ((o.date ?? '') > m ? o.date! : m), '')}</LASTVOUCHERDATE>
    </COMPANY>`
  }

  private renderLookup(o: MockObj): string {
    const extra = o.tag === 'VOUCHER'
      ? `<DATE TYPE="Date">${o.date}</DATE><VOUCHERTYPENAME TYPE="String">${esc(o.vchType)}</VOUCHERTYPENAME><VOUCHERNUMBER TYPE="String">${esc(o.vchNumber)}</VOUCHERNUMBER>`
      : `<NAME TYPE="String">${esc(o.name)}</NAME>`
    const attr = o.tag === 'VOUCHER' ? `REMOTEID="${o.guid}" VCHTYPE="${esc(o.vchType)}"` : `NAME="${esc(o.name)}" RESERVEDNAME="${esc(o.reserved ?? '')}"`
    return `    <${o.tag} ${attr}><GUID TYPE="String">${o.guid}</GUID><MASTERID TYPE="Number"> ${o.masterid}</MASTERID><ALTERID TYPE="Number"> ${o.alterid}</ALTERID>${extra}</${o.tag}>`
  }

  private renderFull(o: MockObj, b: Balances): string {
    let inner = o.xml.replace(/^<[^>]+>/, '').replace(new RegExp(`</${o.tag}>$`), '')
    inner = inner.replace(/<(GUID|ALTERID|MASTERID|CLOSINGBALANCE|CLOSINGVALUE|CLOSINGRATE)>[^<]*<\/\1>/g, '')
    // Real exports wrap names in LANGUAGENAME.LIST
    inner = inner.replace(
      /<NAME\.LIST TYPE="String">([\s\S]*?)<\/NAME\.LIST>/,
      '<LANGUAGENAME.LIST><NAME.LIST TYPE="String">$1</NAME.LIST><LANGUAGEID TYPE="Number"> 1033</LANGUAGEID></LANGUAGENAME.LIST>'
    )
    const common = `<GUID TYPE="String">${o.guid}</GUID><ALTERID TYPE="Number"> ${o.alterid}</ALTERID><MASTERID TYPE="Number"> ${o.masterid}</MASTERID>`
    let computed = ''
    let open: string
    if (o.tag === 'VOUCHER') {
      open = `<VOUCHER REMOTEID="${o.guid}" VCHKEY="${o.guid}:0000000${o.masterid % 10}" VCHTYPE="${esc(o.vchType)}" ACTION="Create" OBJVIEW="${/ALLINVENTORYENTRIES/.test(o.xml) ? 'Invoice Voucher View' : 'Accounting Voucher View'}">`
      computed =
        `<VOUCHERKEY TYPE="Number"> ${o.masterid * 65536}</VOUCHERKEY><ISCANCELLED TYPE="Logical">No</ISCANCELLED><ISOPTIONAL TYPE="Logical">No</ISOPTIONAL>` +
        `<ISDELETED TYPE="Logical">No</ISDELETED><ENTEREDBY TYPE="String">tallytesting</ENTEREDBY><CMPGSTIN TYPE="String">29AAACD1234F1Z5</CMPGSTIN>` +
        `<CMPGSTREGISTRATIONTYPE TYPE="String">Regular</CMPGSTREGISTRATIONTYPE><PLACEOFSUPPLY TYPE="String">Karnataka</PLACEOFSUPPLY>` +
        `<VCHSTATUSDATE TYPE="Date">${o.date}</VCHSTATUSDATE><ALTEREDON TYPE="Date">${o.date}</ALTEREDON>`
    } else {
      open = `<${o.tag} NAME="${esc(o.name)}" RESERVEDNAME="${esc(o.reserved ?? '')}">`
      computed = `<ISDELETED TYPE="Logical">No</ISDELETED><ALTEREDON TYPE="Date">${config.fromDate}</ALTEREDON>`
      if (o.tag === 'LEDGER') {
        const opening = num(firstTagText(o.xml, 'OPENINGBALANCE'))
        computed += `<CLOSINGBALANCE TYPE="Amount">${f2(opening + (b.ledger.get(o.name) ?? 0))}</CLOSINGBALANCE><CURRENCYNAME TYPE="String">₹</CURRENCYNAME>`
      }
      if (o.tag === 'STOCKITEM') {
        const s = b.stock.get(o.name) ?? { qty: 0, inQty: 0, inValue: 0 }
        const unit = firstTagText(o.xml, 'BASEUNITS') ?? ''
        const rate = s.inQty ? s.inValue / s.inQty : 0
        computed += `<CLOSINGBALANCE TYPE="Quantity"> ${s.qty} ${esc(unit)}</CLOSINGBALANCE><CLOSINGVALUE TYPE="Amount">${f2(-s.qty * rate)}</CLOSINGVALUE><CLOSINGRATE TYPE="Rate">${f2(rate)}/${esc(unit)}</CLOSINGRATE>`
      }
      if (o.tag === 'GODOWN') computed += `<HASNOSPACE TYPE="Logical">No</HASNOSPACE><ISEXTERNAL TYPE="Logical">No</ISEXTERNAL>`
    }
    return `    ${open}${common}${computed}${inner}</${o.tag}>`
  }

  private computeBalances(): Balances {
    const ledger = new Map<string, number>()
    const stock = new Map<string, { qty: number; inQty: number; inValue: number }>()
    for (const o of this.state.objects.filter((x) => x.tag === 'STOCKITEM')) {
      const q = num(firstTagText(o.xml, 'OPENINGBALANCE'))
      const v = Math.abs(num(firstTagText(o.xml, 'OPENINGVALUE')))
      stock.set(o.name, { qty: q, inQty: q, inValue: v })
    }
    for (const o of this.state.objects.filter((x) => x.tag === 'VOUCHER' && !ORDER_TYPES.has(x.vchType ?? ''))) {
      const v = parseXml(o.xml).VOUCHER
      const addL = (e: any) => {
        const n = text(e.LEDGERNAME)
        ledger.set(n, (ledger.get(n) ?? 0) + num(e.AMOUNT))
      }
      for (const k of ['LEDGERENTRIES.LIST', 'ALLLEDGERENTRIES.LIST']) asArray(v[k]).forEach(addL)
      for (const inv of asArray<any>(v['ALLINVENTORYENTRIES.LIST'])) {
        asArray(inv['ACCOUNTINGALLOCATIONS.LIST']).forEach(addL)
        const item = text(inv.STOCKITEMNAME)
        const s = stock.get(item) ?? { qty: 0, inQty: 0, inValue: 0 }
        const q = num(inv.ACTUALQTY)
        if (text(inv.ISDEEMEDPOSITIVE) === 'Yes') {
          s.qty += q; s.inQty += q; s.inValue += Math.abs(num(inv.AMOUNT))
        } else s.qty -= q
        stock.set(item, s)
      }
    }
    return { ledger, stock }
  }
}

interface Balances {
  ledger: Map<string, number>
  stock: Map<string, { qty: number; inQty: number; inValue: number }>
}

function decode(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function errorEnvelope(msg: string) {
  return `<ENVELOPE>\n <HEADER>\n  <VERSION>1</VERSION>\n  <STATUS>0</STATUS>\n </HEADER>\n <BODY>\n  <DATA>\n   <LINEERROR>${esc(msg)}</LINEERROR>\n  </DATA>\n </BODY>\n</ENVELOPE>\n`
}

function importResponse(c: { created: number; altered: number; errors: number; lastVchId: number; lastMid: number }, lineErrors: string[]) {
  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <STATUS>1</STATUS>
 </HEADER>
 <BODY>
  <DATA>
   <IMPORTRESULT>
    <CREATED>${c.created}</CREATED>
    <ALTERED>${c.altered}</ALTERED>
    <DELETED>0</DELETED>
    <LASTVCHID>${c.lastVchId}</LASTVCHID>
    <LASTMID>${c.lastMid}</LASTMID>
    <COMBINED>0</COMBINED>
    <IGNORED>0</IGNORED>
    <ERRORS>${c.errors}</ERRORS>
    <CANCELLED>0</CANCELLED>
    <EXCEPTIONS>0</EXCEPTIONS>
   </IMPORTRESULT>
${lineErrors.map((e) => `   <LINEERROR>${esc(e)}</LINEERROR>`).join('\n')}
  </DATA>
 </BODY>
</ENVELOPE>
`
}

function exportEnvelope(body: string, counts: Record<string, number>) {
  const tags = ['COMPANY', 'GROUP', 'LEDGER', 'COSTCATEGORY', 'COSTCENTRE', 'GODOWN', 'STOCKGROUP', 'STOCKCATEGORY', 'STOCKITEM', 'VOUCHERTYPE', 'CURRENCY', 'UNIT', 'VOUCHER']
  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <STATUS>1</STATUS>
 </HEADER>
 <BODY>
  <DESC>
   <CMPINFO>
${tags.map((t) => `    <${t}>${t === 'COMPANY' ? 0 : counts[t] ?? 0}</${t}>`).join('\n')}
   </CMPINFO>
  </DESC>
  <DATA>
   <COLLECTION>
${body}
   </COLLECTION>
  </DATA>
 </BODY>
</ENVELOPE>
`
}

let instance: MockTally | undefined
export function getMockTally(): MockTally {
  instance ??= new MockTally(config.mockStatePath)
  return instance
}
export function resetMockTally() {
  if (fs.existsSync(config.mockStatePath)) fs.rmSync(config.mockStatePath)
  instance = undefined
}

