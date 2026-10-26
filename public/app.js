const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const fmt = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const drcr = (n) => (n === null || n === undefined ? '' : `${fmt(Math.abs(n))} ${n < 0 ? 'Dr' : n > 0 ? 'Cr' : ''}`)

async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
async function act(url, body = {}) {
  $('log').textContent = 'Working…'
  try { $('log').textContent = JSON.stringify(await api(url, body), null, 2) } catch (e) { $('log').textContent = 'ERROR: ' + e.message }
  refresh()
}

function table(rows, cols) {
  if (!rows.length) return '<i>nothing yet</i>'
  return `<table><tr>${cols.map((c) => `<th>${c.h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.cls || ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</table>`
}
function show(title, obj) { $('dlgTitle').textContent = title; $('dlgBody').innerHTML = typeof obj === 'string' ? obj : `<pre>${esc(JSON.stringify(obj, null, 2))}</pre>`; $('dlg').showModal() }

const TABS = [['dashboard', 'Dashboard'], ['create', 'Create'], ['outbox', 'Outbox'], ['tally', 'Tally masters'], ['vouchers', 'Tally vouchers'], ['stock', 'Stock'], ['schema', 'Schema explorer']]
$('tabs').innerHTML = TABS.map(([id, t]) => `<button data-tab="${id}" onclick="tab('${id}')">${t}</button>`).join('')
function tab(id) {
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === id))
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id))
  location.hash = id
  refresh()
}

async function refresh() {
  const active = document.querySelector('section.active')?.id
  if (active === 'dashboard') loadStatus()
  if (active === 'create') loadLocal()
  if (active === 'outbox') loadOutbox()
  if (active === 'tally') loadTally()
  if (active === 'vouchers') loadVouchers()
  if (active === 'stock') loadStock()
  if (active === 'schema') loadSchemaTypes()
}

async function loadStatus() {
  const s = await api('/api/status')
  $('status').innerHTML = `<p>Local: ${s.local.masters} masters, ${s.local.vouchers} vouchers · Outbox: ${s.outbox.map((o) => `<span class="${o.status}">${o.status} ${o.n}</span>`).join(', ') || 'empty'} · Schema fields: ${s.schemaFields}</p>` +
    table(s.syncState, [{ h: 'Object type', k: 'object_type' }, { h: 'Last ALTERID', k: 'last_alterid', cls: 'num' }, { h: 'Last pull', k: 'last_pulled_at' }, { h: 'Objects in last pull', k: 'last_count', cls: 'num' }, { h: 'Error', f: (r) => `<span class="failed">${esc(r.last_error)}</span>` }]) +
    '<p>Pulled objects: ' + s.pulled.map((p) => `${p.object_type}=${p.n}`).join(', ') + '</p>'
}

// ---------- create ----------
const MASTER_FIELDS = {
  ledger: [['name', 'Name'], ['parent', 'Group', 'Sundry Debtors'], ['openingBalance', 'Opening (+Dr/-Cr)'], ['gstin', 'GSTIN'], ['state', 'State'], ['address', 'Address'], ['billWise', 'Bill-wise (yes/no)', 'yes'], ['gstDutyHead', 'GST duty head (tax ledgers)'], ['gstRate', 'Tax rate %']],
  stock_item: [['name', 'Name'], ['parent', 'Stock group'], ['baseUnit', 'Unit', 'Nos'], ['hsn', 'HSN'], ['gstRate', 'GST %', '18'], ['openingQty', 'Opening qty'], ['openingRate', 'Opening rate'], ['godown', 'Godown', 'Main Location']],
  group: [['name', 'Name'], ['parent', 'Parent group', 'Sundry Debtors']],
  unit: [['name', 'Symbol', 'Nos'], ['formalName', 'Formal name'], ['decimals', 'Decimals', '0']],
  stock_group: [['name', 'Name'], ['parent', 'Parent']],
  godown: [['name', 'Name'], ['parent', 'Parent']]
}
const NUMERIC = new Set(['openingBalance', 'gstRate', 'openingQty', 'openingRate', 'decimals'])
function renderMasterForm() {
  $('mFields').innerHTML = MASTER_FIELDS[$('mKind').value].map(([k, l, d]) => `<label>${l}<input data-k="${k}" value="${d ?? ''}" ${k === 'godown' ? 'list="godownNames"' : ''}/></label>`).join('')
}
async function saveMaster() {
  const body = {}
  document.querySelectorAll('#mFields input').forEach((i) => {
    const v = i.value.trim(); if (v === '') return
    body[i.dataset.k] = i.dataset.k === 'billWise' ? /^y/i.test(v) : NUMERIC.has(i.dataset.k) ? Number(v) : v
  })
  try { await api(`/api/local/masters/${$('mKind').value}`, body); renderMasterForm(); loadLocal() } catch (e) { alert(e.message) }
}

function renderVoucherForm() {
  const k = $('vKind').value
  const inv = k !== 'receipt' && k !== 'payment'
  $('vExtra').innerHTML = inv
    ? `<label>Sales/Purchase ledger<input id="vAccount" value="${k.startsWith('sales') ? 'Sales' : 'Purchase'}" list="ledgerNames"/></label>
       <label>GST<select id="vTax"><option value="intra">CGST+SGST (same state)</option><option value="inter">IGST (other state)</option><option value="none">No tax</option></select></label>
       ${k.endsWith('order') ? '<label>Due date<input id="vDue"/></label>' : ''}`
    : `<label>Cash/Bank ledger<input id="vCash" value="Cash" list="ledgerNames"/></label><label>Amount<input id="vAmount"/></label><label>Against bill ref (optional)<input id="vRef"/></label>`
  $('vLines').innerHTML = inv ? '<tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST %</th><th>Godown</th></tr>' : ''
  $('addLine').style.display = inv ? '' : 'none'
  if (inv) addLine()
}
function addLine() {
  $('vLines').insertAdjacentHTML('beforeend', `<tr class="ln"><td><input list="itemNames" data-k="item"/></td><td><input data-k="qty"/></td><td><input data-k="rate"/></td><td><input data-k="gstRate" value="18"/></td><td><input data-k="godown" value="Main Location" list="godownNames"/></td></tr>`)
}
async function saveVoucher() {
  const k = $('vKind').value
  const body = { number: $('vNumber').value.trim() || undefined, date: $('vDate').value.trim(), party: $('vParty').value.trim() }
  if (k === 'receipt' || k === 'payment') Object.assign(body, { cashLedger: $('vCash').value, amount: Number($('vAmount').value), reference: $('vRef').value.trim() || undefined })
  else {
    Object.assign(body, { account: $('vAccount').value, taxMode: $('vTax').value, dueDate: $('vDue')?.value || undefined })
    body.lines = [...document.querySelectorAll('#vLines tr.ln')].map((tr) => {
      const o = {}; tr.querySelectorAll('input').forEach((i) => (o[i.dataset.k] = i.value.trim())); return o
    }).filter((l) => l.item).map((l) => ({ ...l, qty: Number(l.qty), rate: Number(l.rate), gstRate: l.gstRate === '' ? undefined : Number(l.gstRate) }))
  }
  try { const v = await api(`/api/local/vouchers/${k}`, body); alert(`Saved ${v.voucher_number} total ${v.total}`); renderVoucherForm(); loadLocal() } catch (e) { alert(e.message) }
}

async function loadLocal() {
  const d = await api('/api/local')
  const st = (r) => `<span class="${r.status}">${esc(r.status)}</span>${r.error ? `<br><small class="failed">${esc(r.error)}</small>` : ''}`
  $('localList').innerHTML = '<h4>Vouchers</h4>' + table(d.vouchers, [{ h: '#', k: 'id' }, { h: 'Type', k: 'kind' }, { h: 'Number', k: 'voucher_number' }, { h: 'Date', k: 'date' }, { h: 'Party', k: 'party' }, { h: 'Total', f: (r) => fmt(r.total), cls: 'num' }, { h: 'Status', f: st }, { h: 'Tally MASTERID', k: 'masterid' }, { h: '', f: (r) => `<span class="link" onclick="requeue('voucher',${r.id})">re-push</span>` }]) +
    '<h4>Masters</h4>' + table(d.masters, [{ h: '#', k: 'id' }, { h: 'Type', k: 'kind' }, { h: 'Name', k: 'name' }, { h: 'Status', f: st }, { h: 'Tally GUID', k: 'guid' }, { h: '', f: (r) => `<span class="link" onclick="requeue('master',${r.id})">re-push</span>` }])
}
async function requeue(entity, id) { await api(`/api/local/requeue/${entity}/${id}`, {}); loadLocal() }

async function loadOutbox() {
  const rows = await api('/api/outbox')
  $('outboxList').innerHTML = table(rows, [{ h: '#', k: 'id' }, { h: 'Item', k: 'label' }, { h: 'Prio', k: 'priority' }, { h: 'Status', f: (r) => `<span class="${r.status}">${r.status}</span>` }, { h: 'Action', k: 'action' }, { h: 'Tries', k: 'attempts' }, { h: 'Error', f: (r) => `<span class="failed">${esc(r.error)}</span>` }, { h: 'Updated', k: 'updated_at' },
    { h: '', f: (r) => `<span class="link" onclick="outboxXml(${r.id})">XML</span>${r.status === 'failed' ? ` · <span class="link" onclick="act('/api/outbox/${r.id}/retry')">retry</span>` : ''}` }])
}
async function outboxXml(id) {
  const r = await api(`/api/outbox/${id}`)
  show(`Outbox #${id} ${r.label}`, `<h4>Request</h4><pre>${esc(r.request_xml)}</pre><h4>Tally response</h4><pre>${esc(r.response_xml)}</pre>`)
}

async function loadTally() {
  const t = $('tType').value
  const rows = await api(`/api/tally/masters/${t}`)
  const cols = [{ h: 'Name', k: 'name' }, { h: 'Parent', k: 'parent' }, { h: 'MASTERID', k: 'masterid' }, { h: 'ALTERID', k: 'alterid' }]
  if (t === 'ledger') cols.push({ h: 'Opening', f: (r) => drcr(r.opening_balance), cls: 'num' }, { h: 'Closing', f: (r) => drcr(r.closing_balance), cls: 'num' }, { h: 'GSTIN', k: 'gstin' }, { h: 'State', k: 'state_name' })
  if (t === 'stock_item') cols.push({ h: 'Unit', k: 'base_units' }, { h: 'Closing qty', f: (r) => fmt(r.closing_qty), cls: 'num' }, { h: 'Closing value', f: (r) => fmt(r.closing_value === null ? null : Math.abs(r.closing_value)), cls: 'num' }, { h: 'HSN', k: 'hsn' }, { h: 'GST %', k: 'gst_rate' })
  cols.push({ h: 'All fields', f: (r) => `<span class="link" onclick="raw('${t}','${esc(r.guid)}')">raw</span>` })
  $('tallyMasters').innerHTML = `<p>${rows.length} ${t} records pulled from Tally</p>` + table(rows, cols)
}
async function raw(type, guid) {
  const r = await api(`/api/tally/raw/${type}/${encodeURIComponent(guid)}`)
  show(`${type}: ${r.name}`, `<h4>raw_json (every element/attribute)</h4><pre>${esc(JSON.stringify(r.raw_json, null, 2))}</pre><h4>raw_xml</h4><pre>${esc(r.raw_xml)}</pre>`)
}

async function loadVouchers() {
  const rows = await api('/api/tally/vouchers' + ($('vtFilter').value ? `?type=${encodeURIComponent($('vtFilter').value)}` : ''))
  $('voucherList').innerHTML = table(rows, [{ h: 'Date', k: 'date' }, { h: 'Type', k: 'voucher_type' }, { h: 'Number', k: 'voucher_number' }, { h: 'Party', k: 'party' }, { h: 'Amount', f: (r) => fmt(r.amount), cls: 'num' }, { h: 'MASTERID', k: 'masterid' }, { h: 'ALTERID', k: 'alterid' },
    { h: '', f: (r) => `<span class="link" onclick="vdetail('${esc(r.guid)}')">lines</span> · <span class="link" onclick="raw('voucher','${esc(r.guid)}')">raw</span>` }])
}
async function vdetail(guid) {
  const d = await api(`/api/tally/voucher/${encodeURIComponent(guid)}`)
  show(`${d.voucher.voucher_type} ${d.voucher.voucher_number}`,
    '<h4>Inventory</h4>' + table(d.inventoryEntries, [{ h: 'Item', k: 'item' }, { h: 'Godown', k: 'godown' }, { h: 'Qty', k: 'qty', cls: 'num' }, { h: 'Unit', k: 'unit' }, { h: 'Rate', k: 'rate', cls: 'num' }, { h: 'Amount', f: (r) => fmt(r.amount), cls: 'num' }, { h: 'Inward', f: (r) => (r.is_deemed_positive ? 'in' : 'out') }]) +
    '<h4>Ledgers</h4>' + table(d.ledgerEntries, [{ h: 'Ledger', k: 'ledger' }, { h: 'Source', k: 'source' }, { h: 'Amount', f: (r) => drcr(r.amount), cls: 'num' }]))
}

async function loadStock() {
  const rows = await api('/api/tally/stock')
  $('stockList').innerHTML = '<p><b>tally_closing</b> = Tally\'s own closing per item (all godowns). <b>computed</b> = per godown from opening allocations + pulled vouchers (orders excluded).</p>' +
    table(rows, [{ h: 'Item', k: 'item' }, { h: 'Godown', k: 'godown' }, { h: 'Qty', f: (r) => fmt(r.qty), cls: 'num' }, { h: 'Unit', k: 'unit' }, { h: 'Value', f: (r) => fmt(r.value), cls: 'num' }, { h: 'Source', k: 'source' }])
}

async function loadSchemaTypes() {
  const types = await api('/api/schema')
  const cur = $('sType').value
  $('sType').innerHTML = types.map((t) => `<option value="${t.object_type}" ${t.object_type === cur ? 'selected' : ''}>${t.object_type} (${t.fields})</option>`).join('')
  loadSchema()
}
async function loadSchema() {
  const t = $('sType').value
  if (!t) { $('schemaList').innerHTML = '<i>Pull from Tally first</i>'; return }
  const rows = await api(`/api/schema/${t}?q=${encodeURIComponent($('sQ').value)}`)
  $('sInfo').textContent = `${rows.length} distinct field paths`
  $('schemaList').innerHTML = table(rows, [{ h: 'Path', k: 'path' }, { h: 'Seen', k: 'occurrences', cls: 'num' }, { h: 'Tally type', k: 'tally_type' }, { h: 'Sample', k: 'sample_value' }, { h: 'First seen', k: 'first_seen' }])
}

async function loadLists() {
  try {
    const [l, i, g] = await Promise.all(['ledger', 'stock_item', 'godown'].map((t) => api(`/api/tally/masters/${t}`)))
    const local = await api('/api/local')
    const names = (rows, kind) => [...new Set([...rows.map((r) => r.name), ...local.masters.filter((m) => m.kind === kind).map((m) => m.name)])]
    $('ledgerNames').innerHTML = names(l, 'ledger').map((n) => `<option value="${esc(n)}">`).join('')
    $('itemNames').innerHTML = names(i, 'stock_item').map((n) => `<option value="${esc(n)}">`).join('')
    $('godownNames').innerHTML = names(g, 'godown').map((n) => `<option value="${esc(n)}">`).join('')
  } catch {}
}

;(async () => {
  const c = await api('/api/config')
  $('cfg').innerHTML = `<span class="badge">${c.mode.toUpperCase()}</span> ${esc(c.tallyUrl)} · company "${esc(c.company)}" · period ${c.fromDate}–${c.toDate}`
  const d = new Date(); $('vDate').value = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  renderMasterForm(); renderVoucherForm(); loadLists()
  tab(location.hash.slice(1) || 'dashboard')
  setInterval(loadLists, 15000)
})()
