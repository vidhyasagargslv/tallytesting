import { XMLParser } from 'fast-xml-parser'

/** Escape a value for use inside XML text or attribute. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Tally emits control characters (e.g. &#4; as a "not applicable" marker) that are
 * illegal in XML 1.0 and break parsers. Strip them before parsing.
 */
export function sanitize(xml: string): string {
  return xml
    .replace(/^\uFEFF/, '')
    .replace(/&#(?:x0*(?:[0-8bcefBCEF]|1[0-9a-fA-F])|0*(?:[0-8]|1[124-9]|2[0-9]|3[01]));/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  // Every Tally *.LIST element is a repeating list: always make it an array
  isArray: (name) => name.endsWith('.LIST')
})

/** Full XML -> JSON conversion. Every element and attribute is preserved (attributes prefixed with @). */
export function parseXml(xml: string): any {
  return parser.parse(sanitize(xml))
}

/** Text content of a parsed node ('' when missing). */
export function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length ? text(value[0]) : ''
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('#text' in obj) return text(obj['#text'])
    return ''
  }
  return ''
}

/** Parse Tally numbers like "-156000.00", " 5 Nos", "100.00/Nos", "1,200.50". */
export function num(value: unknown): number {
  const s = text(value).replace(/,/g, '')
  const m = s.match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : 0
}

export function asArray<T = any>(value: unknown): T[] {
  if (value === undefined || value === null || value === '') return []
  return (Array.isArray(value) ? value : [value]) as T[]
}

/** Extract top-level occurrences of <TAG ...>...</TAG> (or self-closing) as raw XML strings. */
export function extractElements(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g')
  return xml.match(re) ?? []
}

/** Return the inner part of the first <TAG>...</TAG> block, or '' */
export function innerOf(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*)</${tag}>`))
  return m ? m[1] : ''
}

export function firstTagText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`))
  return m ? m[1].trim() : undefined
}

export interface FieldInfo { path: string; sample: string; tallyType: string }

/**
 * Flatten a parsed object into every distinct field path, e.g.
 * ALLINVENTORYENTRIES.LIST[].BATCHALLOCATIONS.LIST[].GODOWNNAME  and  @NAME
 */
export function flattenPaths(node: unknown, prefix = '', out = new Map<string, FieldInfo>()): Map<string, FieldInfo> {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) flattenPaths(item, `${prefix}[]`, out)
    return out
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    const keys = Object.keys(obj)
    const tallyType = typeof obj['@TYPE'] === 'string' ? (obj['@TYPE'] as string) : ''
    if (keys.length === 0 || (keys.every((k) => k.startsWith('@') || k === '#text') && prefix)) {
      // leaf with attributes only / text
      record(out, prefix, text(obj), tallyType)
    }
    for (const k of keys) {
      if (k === '#text') continue
      const p = prefix ? `${prefix}.${k}` : k
      flattenPaths(obj[k], p, out)
    }
    return out
  }
  record(out, prefix, String(node), '')
  return out
}

function record(out: Map<string, FieldInfo>, path: string, sample: string, tallyType: string) {
  if (!path) return
  const existing = out.get(path)
  if (!existing) out.set(path, { path, sample, tallyType })
  else if (!existing.sample && sample) existing.sample = sample
}
