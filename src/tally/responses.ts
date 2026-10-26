import { firstTagText } from './xml.js'

export interface ImportResult {
  ok: boolean
  created: number
  altered: number
  deleted: number
  combined: number
  ignored: number
  errors: number
  cancelled: number
  exceptions: number
  lastVchId: number
  lastMid: number
  lineErrors: string[]
}

/** Parse both the TallyPrime (<ENVELOPE>..<IMPORTRESULT>) and legacy (<RESPONSE>) import result shapes. */
export function parseImportResponse(xml: string): ImportResult {
  const n = (tag: string) => Number(firstTagText(xml, tag) ?? 0) || 0
  const lineErrors = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => decode(m[1].trim()))
  const r: ImportResult = {
    ok: false,
    created: n('CREATED'),
    altered: n('ALTERED'),
    deleted: n('DELETED'),
    combined: n('COMBINED'),
    ignored: n('IGNORED'),
    errors: n('ERRORS'),
    cancelled: n('CANCELLED'),
    exceptions: n('EXCEPTIONS'),
    lastVchId: n('LASTVCHID'),
    lastMid: n('LASTMID'),
    lineErrors
  }
  r.ok = r.errors === 0 && r.exceptions === 0 && lineErrors.length === 0 && r.created + r.altered + r.combined > 0
  return r
}

/** Export-level error (e.g. company not open, bad TDL). */
export function exportError(xml: string): string | undefined {
  const status = firstTagText(xml, 'STATUS')
  const lineErrors = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => decode(m[1].trim()))
  if (lineErrors.length) return lineErrors.join('; ')
  if (status === '0') return 'Tally returned STATUS 0'
  return undefined
}

function decode(s: string) {
  return s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
