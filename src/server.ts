import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { config } from './config.js'
import { getDb } from './db.js'
import { tally } from './tally/client.js'
import { OBJECTS, buildCollectionExport } from './tally/exports.js'
import { exportError } from './tally/responses.js'
import { extractElements, innerOf, text, parseXml } from './tally/xml.js'
import type { MasterKind, VoucherKind } from './tally/imports.js'
import { createMaster, createVoucher, listLocal, requeue, seedDemoMasters } from './services/local.js'
import { pushPending } from './services/push.js'
import { pullAll } from './services/pull.js'
import * as q from './services/query.js'

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use(express.static(path.join(config.root, 'public')))

const h = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res)
    if (!res.headersSent) res.json(out ?? { ok: true })
  } catch (e) {
    next(e)
  }
}

app.get('/api/config', h(() => ({ mode: config.mode, tallyUrl: config.tallyUrl, company: config.company, fromDate: config.fromDate, toDate: config.toDate, autoSyncSeconds: config.autoSyncSeconds })))
app.get('/api/status', h(() => q.status()))

app.post('/api/test-connection', h(async () => {
  const xml = await tally().post(buildCollectionExport(OBJECTS.company, { company: config.company }))
  const err = exportError(xml)
  if (err) return { ok: false, error: err }
  const companies = extractElements(innerOf(xml, 'DATA') || xml, 'COMPANY').map((el) => {
    const j = parseXml(el).COMPANY
    return String(j['@NAME'] ?? text(j.NAME))
  })
  return { ok: true, mode: config.mode, companies, configuredCompanyOpen: companies.some((c) => c.toLowerCase() === config.company.toLowerCase()) }
}))

// ---- local data ----
app.get('/api/local', h(() => listLocal()))
app.post('/api/local/masters/:kind', h((req) => createMaster(req.params.kind as MasterKind, req.body)))
app.post('/api/local/vouchers/:kind', h((req) => createVoucher(req.params.kind as VoucherKind, req.body)))
app.post('/api/local/requeue/:entity/:id', h((req) => ({ outboxId: requeue(req.params.entity as 'master' | 'voucher', Number(req.params.id)) })))
app.post('/api/demo/seed-masters', h(() => { seedDemoMasters(); return listLocal() }))

// ---- sync ----
app.post('/api/push', h(() => pushPending()))
app.post('/api/pull', h((req) => pullAll({ full: !!req.body?.full })))
app.post('/api/sync', h(async (req) => ({ push: await pushPending(), pull: await pullAll({ full: !!req.body?.full }) })))
app.get('/api/outbox', h(() => q.outbox()))
app.get('/api/outbox/:id', h((req) => q.outboxDetail(Number(req.params.id))))
app.post('/api/outbox/:id/retry', h((req) => {
  getDb().prepare("UPDATE outbox SET status='pending' WHERE id=? AND status='failed'").run(Number(req.params.id))
  return pushPending()
}))

// ---- pulled from Tally ----
app.get('/api/tally/masters/:type', h((req) => q.tallyMasters(String(req.params.type))))
app.get('/api/tally/vouchers', h((req) => q.tallyVouchers(req.query.type ? String(req.query.type) : undefined)))
app.get('/api/tally/voucher/:guid', h((req) => q.tallyVoucher(String(req.params.guid))))
app.get('/api/tally/raw/:type/:guid', h((req) => q.rawObject(String(req.params.type), String(req.params.guid))))
app.get('/api/tally/stock', h(() => q.stock()))
app.get('/api/schema', h(() => q.schemaTypes()))
app.get('/api/schema/:type', h((req) => q.schemaFields(String(req.params.type), String(req.query.q ?? ''))))

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
})

getDb()
app.listen(config.port, () => {
  console.log(`tallytesting on http://localhost:${config.port}  mode=${config.mode}  tally=${config.tallyUrl}  company="${config.company}"`)
})

if (config.autoSyncSeconds > 0) {
  setInterval(async () => {
    try {
      const push = await pushPending()
      const pull = await pullAll()
      console.log(`[auto-sync] pushed ${push.synced}/${push.attempted}, pulled ${pull.reduce((s, r) => s + r.objects, 0)} objects`)
    } catch (e) {
      console.error('[auto-sync] failed', e)
    }
  }, config.autoSyncSeconds * 1000)
}
