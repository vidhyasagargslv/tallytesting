# tallytesting: TallyPrime two-way sync demo

Create masters and vouchers in this app, **push** them into TallyPrime (XML import over HTTP), then **pull** everything back
(XML export with full objects) into SQLite. It runs on a Mac with **no Tally** in mock mode. On Windows you switch
one setting to talk to real TallyPrime.

## What it does

| Area | Push to Tally (Import Data) | Pull from Tally (Export) |
|---|---|---|
| Masters | groups, units, godowns, stock groups, ledgers (party with GSTIN/state/address, GST duty ledgers), stock items (HSN, GST rate, opening qty per godown) | company, groups, ledgers, units, stock groups, godowns, stock items, voucher types |
| Vouchers | Sales Order, Sales invoice, Purchase Order, Purchase invoice, Receipt, Payment | all vouchers in the period (with ledger, inventory, batch/godown, bill allocations) |
| Inventory | opening stock per godown on items | Tally closing qty and value per item, and a per-godown summary computed from pulled vouchers |

**Full data capture.** Every pull uses a TDL **Collection export with `NATIVEMETHOD *` and `FETCH *`** (plus explicit sub-lists),
not a report with fixed columns. For each object, `tally_objects` stores:
- `raw_xml`: the exact XML element Tally returned.
- `raw_json`: a lossless JSON conversion that keeps every element and attribute (attributes are prefixed `@`, and `*.LIST` values are always arrays).
- normalized columns (`t_masters`, `t_vouchers`, `t_voucher_ledger_entries`, `t_voucher_inventory_entries`, `t_stock_summary`) for the UI.

**Schema explorer.** `schema_fields` records every distinct field path seen per object type
(e.g. `ALLINVENTORYENTRIES.LIST[].BATCHALLOCATIONS.LIST[].GODOWNNAME`) with how often it was seen, a sample value and Tally's `TYPE`.
It's the "Schema explorer" tab in the UI.

### Sync design
- **Outbox** (`outbox`): saving anything creates a `pending` row. A push runs in dependency order
  (groups, units, godowns, stock groups, ledgers, stock items, then vouchers) and stores the request XML, Tally's response,
  `CREATED/ALTERED/ERRORS/LINEERROR`, and status `synced`/`failed`. Failed rows can be retried.
- **Idempotent**: before each push the app looks the object up in Tally (masters by name; vouchers by voucher type and the app's fixed
  voucher number such as `TT/SI/0001`). If it exists, the push sends `ACTION="Alter"`, otherwise `ACTION="Create"`, so re-pushing never duplicates.
- **Mapping** (`tally_map`): local id to Tally GUID, MASTERID and ALTERID.
- **Incremental pull**: per object type, only objects with `$AlterID > last seen` (`sync_state`). "Full pull" re-reads everything
  and removes local copies of objects deleted in Tally. Closing balances (ledgers and stock) are refreshed on every pull, because
  entering a voucher doesn't change the ledger's or item's own ALTERID.
- **Mock Tally** (`src/mock/mockTally.ts`): a stateful simulator that accepts the same XML, validates it like Tally
  (missing group/ledger/item/unit/godown, unbalanced voucher, duplicate master), assigns GUID/MASTERID/ALTERID, computes balances,
  and answers with TallyPrime-shaped XML modeled on real output captured from your previous project.

## Layout
```
src/
  config.ts             env/config (.env)
  db.ts                 SQLite schema (better-sqlite3)
  server.ts             Express API + serves public/
  tally/client.ts       HTTP client: timeout, UTF-8/UTF-16 decoding, mock switch
  tally/imports.ts      Import XML builders (masters, vouchers; balanced Dr/Cr; GST)
  tally/exports.ts      Collection export builders (FETCH *), lookups, incremental filter
  tally/responses.ts    Import/export response parsing
  tally/xml.ts          parser (full XML->JSON), sanitizer for Tally control chars, field-path flattener
  mock/mockTally.ts     simulated TallyPrime
  mock/server.ts        mock exposed over HTTP (like port 9000)
  services/local.ts     create local data + outbox, demo seed
  services/push.ts      outbox processor (lookup -> Create/Alter -> map)
  services/pull.ts      full/incremental pull, normalization, schema explorer, stock summary
  services/query.ts     read queries for UI
public/                 UI (plain HTML/JS, no build step)
scripts/e2e.ts          mock end-to-end test (npm test)
scripts/mock-tally-server.ts   run mock Tally on :9000
scripts/gen-windows-requests.ts generates windows/requests/*.xml from the app's builders
windows/tally-test.ps1  posts those requests to real Tally, saves responses
```

## Run on Mac (mock, no Tally)
```bash
cd /Users/vidhya/perso/tallytesting
npm install
cp .env.example .env          # TALLY_MODE=mock
npm test                      # end-to-end check, should print "ALL 15 CHECKS PASSED"
npm start                     # http://localhost:4000
```
In the UI: **Dashboard → Create demo masters → Push to Tally → Create tab → add a Sales invoice → Sync now**,
then look at Tally vouchers, Stock, Tally masters (click "raw" to see every field) and the Schema explorer.
`npm run reset` wipes the local DB and mock Tally state.

To exercise the real HTTP client against the mock, run `npm run mock-tally` in one terminal (add `MOCK_UTF16=1` to test UTF-16 responses),
set `TALLY_MODE=real` and `TALLY_URL=http://localhost:9000` in `.env`, then `npm start`.

## Run on Windows with real TallyPrime
1. **Use a separate demo company.** In TallyPrime create a company such as `Demo Sync Co` (F3 > Create Company) with
   *Maintain Inventory = Yes* and GST enabled (F11 > Statutory). Never point this at your live company.
2. **Enable the XML/HTTP port.** Go to F1 (Help) > Settings > Connectivity > Client/Server configuration and set
   *TallyPrime acts as* = **Both** (or Server) and *Port* = **9000**. Restart Tally.
   (In Tally.ERP 9 this is F12 > Advanced Configuration.) Keep the demo company **open**, because exports and imports go to the loaded company.
3. Check that it answers: open `http://localhost:9000` in a browser. It should say *TallyPrime Server is Running*.
4. Install Node.js 20.12+ (LTS), copy this folder (without `node_modules` and `data/*.db`), then:
   ```powershell
   npm install
   copy .env.example .env
   # edit .env: TALLY_MODE=real, TALLY_COMPANY=Demo Sync Co (exact name), TALLY_FROM_DATE / TALLY_TO_DATE = company FY
   npm run typecheck
   npm start
   ```
   better-sqlite3 needs a prebuilt binary for your Node version. If install fails, use Node LTS (22/24) or install the VS Build Tools.
5. **Raw request check first (recommended):**
   ```powershell
   powershell -ExecutionPolicy Bypass -File windows\tally-test.ps1 -Company "Demo Sync Co" -Date 20260415
   ```
   It posts every file in `windows/requests` (list companies, create test masters prefixed `TT Test`, create/lookup/alter a sales
   invoice, sales order, receipt, an intentionally unbalanced voucher, and full exports of every object type) and saves
   the responses to `windows/output/`. Send me that folder, and I'll tune the mocks and parsers to the real output.
   After changing the builders, run `npm run gen:windows-requests` to regenerate the files.

## Manual round-trip test (real Tally)
1. Dashboard → **Test connection**. It should show `configuredCompanyOpen: true`.
2. **Create demo masters (local)** → **Push to Tally**. In Outbox, all rows should be `synced` (Create). In Tally, check
   Gateway > Chart of Accounts: ledgers *Acme Retail Pvt Ltd*, *Zen Supplies*, *Sales*, *Purchase*, *CGST/SGST/IGST*, *HDFC Bank*,
   units *Nos/Kg*, godown *Warehouse A*, items *USB-C Cable 1m* (100 opening) and *Wireless Mouse* (40 in Warehouse A).
3. Create tab: add a **Sales invoice** to Acme (e.g. 10 × USB-C @ 200, 18% CGST+SGST) → **Push**. In Tally's Day Book
   the invoice `TT/SI/0001` should appear with tax and a bill reference, and the USB-C stock should drop to 90.
4. Click **re-push** on the same voucher → Outbox shows `Alter` and Tally still has only one `TT/SI/0001`.
5. Add a Sales Order, a Purchase (Zen, IGST), a Receipt and a Payment → Push → check them in Tally.
6. **In Tally**, enter a purchase by hand (e.g. 5 × Wireless Mouse). Then **Pull** in the app: only the changed vouchers come back
   (Dashboard shows last ALTERID per type). In **Stock**, the Wireless Mouse quantity goes up. **Tally vouchers** lists your manual entry.
7. **Schema explorer**: browse every field Tally sent (voucher, ledger, stock_item, ...). Click "raw" on any record for the full XML/JSON.
8. Delete a voucher in Tally → **Full pull** → it disappears locally.

## Known assumptions to verify on real Tally
- **GST fields on ledgers/items**: TallyPrime 3.x/4.x+ keep party GSTIN/state in dated `LEDGSTREGDETAILS.LIST` / `LEDMAILINGDETAILS.LIST`;
  older releases use `PARTYGSTIN`/`LEDSTATENAME`. The builder sends both. Check which one sticks (open the ledger in Tally).
  Item GST uses `GSTDETAILS.LIST > STATEWISEDETAILS.LIST > RATEDETAILS.LIST`. Newer releases may want the HSN/rate in
  `HSNDETAILS.LIST`/`GSTDETAILS.LIST` with a different shape.
- **Voucher Alter** uses `ACTION="Alter"` with `TAGNAME="Voucher Number" TAGVALUE=... DATE=...`. If Tally answers *Voucher does not exist*,
  switch to altering by `REMOTEID`/GUID or `MASTERID` (GUID is already stored in `tally_map`).
- **Sales invoice** uses `Invoice Voucher View` with `ALLINVENTORYENTRIES.LIST` + `ACCOUNTINGALLOCATIONS.LIST` and `LEDGERENTRIES.LIST`
  for party and taxes. If GST isn't auto-calculated or Tally flags a difference, check the tax ledgers' *Type of duty* and the item GST rate.
- **Orders**: `ORDERNO`/`ORDERDUEDATE` sit inside `BATCHALLOCATIONS.LIST`. Linking an invoice to an order (tracking against the order) isn't implemented yet.
- **Receipt/Payment bill allocation**: `Agst Ref` with the invoice number when a reference is given, otherwise `On Account`.
- **Lookup/Incremental filters**: `$Name = "..."`, `$VoucherNumber`, `$VoucherTypeName`, `$AlterID > n` are TDL formula filters in the export.
  Vouchers are fetched only within `TALLY_FROM_DATE..TALLY_TO_DATE`.
- **FETCH * on vouchers** may still omit some sub-collections in some releases. The explicit FETCH list covers ledger, inventory, batch and bill
  allocations. Use the Schema explorer to see what actually arrived.
- **Per-godown stock** is computed from opening batch allocations plus pulled vouchers (orders, optional and cancelled vouchers excluded).
  Tally's own number is item-level (`CLOSINGBALANCE`). A Godown Summary export can be added later if the two differ.
- **Encoding**: the client decodes UTF-16LE/UTF-8 and strips Tally control characters such as `&#4;`.
- Masters deleted in Tally are only noticed on a **Full pull**. Deleting or cancelling vouchers from the app isn't implemented.
- Voucher types aren't created by the app. It assumes Tally's defaults (`Sales`, `Purchase`, `Sales Order`, `Purchase Order`, `Receipt`, `Payment`).
