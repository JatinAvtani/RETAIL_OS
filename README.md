# Vyapaar

Operations intelligence for food-service retail — cafés, bakeries, and restaurants.

Vyapaar reads POS sales and supplier prices, reconciles them against recipes and an append-only
stock ledger, and answers the question most small food businesses cannot answer:

> **Where did my margin actually go?**

The headline output is **cost variance** — the gap between what your recipes say you should have
consumed and what your stock ledger says you actually consumed. That gap is waste, over-portioning,
and shrinkage combined. It is invisible without *both* a recipe model and a movement ledger, which
is why almost no small business knows the number.

---

## The design principle everything follows

A wrong business number is worse than a missing one.

A dashboard showing `$0.00` for a cost nobody ever recorded looks like excellent cost control. It
reads as a fact, invites decisions, and gives no signal that anything is missing. So the system is
built so that **an unknown value stays unknown, all the way to the screen** — never defaulted,
never partially summed, never estimated.

That single rule shapes the schema, the type system, the metric layer, and the UI:

| Situation | What most systems do | What Vyapaar does |
|---|---|---|
| Ingredient has no confirmed price | Treat as `0` | Recipe cost reports **unknown** |
| One lot's cost is unrecorded | Sum the rest | Period COGS reports **unknown** |
| Zero revenue in a period | Food cost = `0%` | Reports **unknown** (0% would read as flawless) |
| Sale references an unmapped POS item | Silently skip it | Quarantine it, count the revenue, **show the gap** |

The dashboard also reports its own **data completeness** — how many sale lines came from unmapped
items, how many consumption events had no known cost. Showing what's missing is a trust feature,
not an admission of weakness: a number computed over partial data is only usable if you know how
partial it is.

---

## What's built

**Identity & multi-tenancy** — signup creates a real organization, store, and owner account in one
transaction (email verification, password + Google OAuth login, invitations, password reset,
role-based permissions, Redis-backed sessions with revocation), plus a team-management screen to
invite, change roles, remove members, and revoke pending invitations.

**Tenant isolation, enforced at four layers** — Postgres row-level security, `SET LOCAL` tenant
context per transaction, an application-layer repository guard that refuses to build an unscoped
query, and an automated cross-tenant attack suite that walks the *real* router and proves every
id-shaped endpoint rejects a foreign tenant. Adding an endpoint without registering it fails the
build.

**Catalog & costing** — products, variants, categories, units with an explicit conversion graph,
suppliers, and effective-dated supplier prices where overlapping validity periods are rejected by
a database exclusion constraint rather than application code.

**Recipes** — recursive explosion with waste factors, effective-dated versions, and cycle detection
performed at save time via depth-first search.

**Inventory ledger** — an append-only, range-partitioned `stock_movements` table where `UPDATE` and
`DELETE` are revoked at the database role level; corrections are compensating rows. Plus lot
tracking with FEFO allocation, a stock-level projection reconciled against the ledger, stocktakes
with a frozen point-in-time snapshot, inter-store transfers with an in-transit state, waste logging
with enforced reason codes, and expiry ranking by value at risk.

**Sales ingestion** — Square OAuth with encrypted credentials, catalog and order sync, signature-
verified webhooks, refund and void reversal (including staged partial refunds), a nightly
reconciliation sweep that catches missed webhooks without disturbing the incremental sync cursor,
CSV import with per-row content-hash idempotency, and a POS-item-to-menu-item mapping surface with
fuzzy suggestions that a human always confirms.

**Metrics & dashboards** — a registered catalog of ~60 business-number functions (sales, cost,
margin and attribution, inventory, waste/shrinkage, purchasing, supplier performance, document
health, anomaly detection) — every dashboard figure and every future AI answer reads through the
same single code path, `executeMetric`, never a second ad-hoc query. Owner and manager dashboards
show period-over-period deltas, 12-point sparklines, a deterministic exception feed, and top/bottom
menu items by contribution, plus a real drill-through from any headline number back to the rows it
was computed from. Hybrid lexical + vector search over supplier documents. Each org chooses its
currency once at signup (no conversion logic exists anywhere — the choice is permanent by design)
and every number for that org is computed and labelled in it, correctly, from day one.

**Supplier invoice pipeline** — upload or email in an invoice; dual-provider extraction (a vision
model primary, OCR fallback behind a circuit breaker) reads it; deterministic validation gates check
line arithmetic, document totals, duplicates, and price anomalies before any human sees it;
confidence-based routing auto-approves the clean ones and queues the rest for review. A human
approves, rejects, or corrects a supplier-SKU mapping — corrections become permanent mappings, never
one-off guesses. Approval posts a real price history entry and a real stock receipt in a single
transaction, and every posted number links back to the source document and forward from it, so any
figure on the dashboard traces to the invoice it came from.

**Purchasing** — reorder suggestions computed from trimmed-mean daily consumption, safety stock, and
supplier lead time, each carrying a plain-language explanation and rounded to a real pack size and
minimum order value. A filterable order list (keyset-paginated — a page can never skip or double-show
an order) fronts a state machine (draft → submitted → approved →
sent → received), immutable once sent, with approval thresholds enforced per manager. Sending
generates a real PDF and a mocked supplier email. Receiving supports partial deliveries, discrepancy
codes, damage photos, and walk-in purchases with no PO at all — all of it posting real lots and stock
movements through the same ledger the invoice pipeline uses.

**Three-way match** — every posted invoice is automatically reconciled against its purchase order and
what was actually received. Price and quantity variances outside a configurable tolerance land in a
review queue, worst severity first; an item invoiced but never received is flagged high priority as a
possible billing error. A manager resolves a variance with a required note, which is the whole audit
trail.

**Supplier performance** — delivery timing, fill rate, price variance, and invoice accuracy are
recorded as events off the receiving and matching flows that already exist, then read back as
components on a scorecard with drill-through to the source event and a real period-over-period trend
for each one. A real, threshold-crossing price change is flagged with its annualised dollar impact —
translating a percentage into a number an owner will actually act on. There is deliberately no single
composite score: an invented weighted average would be exactly the fabricated-scoring problem this
project exists to avoid.

**AI assistant, grounded** — a chat surface where a question is classified, planned against the
registered metric catalog, and answered only from values the catalog actually computed; the model
routes and narrates, it never does arithmetic. Every narrated answer then passes a deterministic
validator: each numeric token in the response must match a computed value (within formatting
tolerance) or appear verbatim in a retrieved document excerpt, one stricter regeneration is
allowed on a violation, and a second violation discards the prose entirely in favour of the
structured results — a figure from nowhere cannot reach the screen through the narration path.
Document questions run hybrid retrieval (lexical + vector, fused by reciprocal rank) over
structure-aware invoice chunks; every excerpt enters the prompt wrapped in an untrusted-data
delimiter, so a document that says "ignore your rules" is read as data, not obeyed. A daily
briefing narrates the dashboard's exception feed through the same validator gate. Each cited
figure carries its own provenance panel: the period, the data-freshness timestamp, and the source
tables with row counts. Citations are
source-level (which tables, how many rows, as of when), not per-line-item. When something can't be
answered — a missing permission, an unknowable metric — the answer says which part and why,
rather than narrating around the gap.

**Notifications, computed not polled** — alerts come from a rule engine evaluating real state
(stock against par levels, lots against expiry dates), so a rule that does not fire produces no
alert rather than a reassuring empty list. Each alert carries a deduplication key, so a persistent
problem updates in place instead of arriving daily, and resolves itself when the condition clears.
Severity, recipients, and channels are per-rule configuration; delivery is tracked per recipient
per channel.

**Guided onboarding** — a setup flow that tracks real recorded progress rather than inferring
"looks empty": connect sales, upload invoices, confirm detected products and suppliers, set par
levels. Each step is independently skippable, and a skipped step is a decision the system
remembers rather than a gap it keeps prompting about.

---

## Architecture

A modular monolith across three processes, chosen over microservices because receiving goods
atomically touches lots, movements, the stock projection, and the event outbox — as separate
services that becomes a distributed saga with compensating actions, for a workload with no
independent scaling need. The split is by **resource profile**, not by domain noun.

```
apps/web         Next.js 15 App Router
apps/api         Fastify — tRPC
apps/worker      Background consumers

packages/domain  Pure business logic, no I/O — costing, FEFO, recipe explosion
packages/db      Schema, migrations, repositories, tenant guards
packages/metrics The metric catalog — the only place a business number is computed, ~60 functions
packages/ai      All model calls — extraction, classification, embeddings, prompt safety
packages/assistant The grounded answering pipeline — classify, plan, retrieve, narrate, validate
packages/pos     POS vendor adapters and the canonical sales model
packages/authz   Permission model
packages/session Redis-backed sessions
packages/storage S3-compatible object storage
packages/email   Outbound mail (mocked transport) and inbound invoice intake
packages/queue   Background job queue (BullMQ)
```

Module boundaries are enforced in CI by dependency-cruiser, so the layering can't quietly erode.

**Postgres 16** (pgvector, pg_trgm, btree_gist) · **Redis** · **S3/MinIO** · TypeScript strict
throughout.

---

## Decisions worth explaining

**Money is a branded decimal type, never `number`.** Float arithmetic on money loses precision
silently — the error is invisible until it isn't. Quantities carry their unit in the type, making
a unit mismatch a compile error rather than a value that's wrong by a factor of 1000.

**The ledger is append-only, enforced by the database.** Not by convention or an ORM hook — the
application role has `UPDATE` and `DELETE` revoked on the movements table. A correction is a new
row. This is what makes historical numbers reproducible.

**Stocktakes freeze a snapshot when the count starts.** Comparing a 9am physical count against an
11am theoretical balance manufactures variance out of sales that happened during the count.

**Business numbers come from one registered function each.** If the dashboard and an API computed
"food cost %" through different code paths, they would eventually disagree — and the moment a user
sees two different values for the same thing, every number loses credibility.

**Deterministic where wrong answers cost money.** All arithmetic, reorder quantities, margin
attribution, and FEFO allocation are ordinary tested code. Probabilistic techniques are confined to
document extraction and fuzzy match *suggestions*, which a human confirms.

**Times are stored UTC, resolved in store-local time.** A restaurant's "yesterday" is a local-time
concept; a sale at 23:45 on the 31st lands in the wrong month otherwise.

**Accessibility is fixed at the design token, never the call site.** Every colour pairing in both
themes is contrast-measured against WCAG AA, and the passing values live in the tokens themselves —
so a new screen inherits compliant contrast, a keyboard focus ring, semantic table headers, and
reduced-motion behaviour by using the shared primitives, rather than remembering thirty rules.

---

## Testing

Financial and inventory calculations get property-based tests asserting invariants rather than
examples — stock never diverges from the ledger sum, recipe explosion conserves quantity, FEFO
never over-allocates a lot, margin components sum exactly to the total. These are the calculations
where a subtle bug produces wrong numbers for months, and example-based tests miss precisely the
edge cases that matter.

Integration tests run against real Postgres and real Redis, never mocks: row-level security proves
nothing against a fake database. Database constraints are verified directly — both the rejection
and the adjacent accepted case — before any code depends on them.

The assistant carries its own golden evaluation set — metric-routing, honest-refusal, and
prompt-injection cases that run through the real pipeline against the live model
(`pnpm --filter @retailos/api eval`), because injection resistance is a claim about a model, not
about code, and only a real run turns it into a measurement.

---

## Running it

```bash
cp .env.local.example .env.local   # fill in GEMINI_API_KEY to exercise the invoice pipeline

docker compose up -d          # Postgres, Redis, MinIO
pnpm install
pnpm --filter @retailos/db db:migrate
pnpm --filter @retailos/db db:migrate:concurrent

pnpm --filter @retailos/api dev    # :3001
pnpm --filter @retailos/web dev    # :3000
```

```bash
pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test
```

### Demo data

The repository contains a **generator**, not a dataset. `mock-data/generate/` is committed; the
corpus it produces is gitignored, so a fresh clone reproduces it rather than downloading it:

```bash
pnpm --filter @retailos/api exec tsx ../../mock-data/generate/generate.mts   # write the corpus
pnpm --filter @retailos/api exec tsx src/scripts/seed-demo.mts               # catalog + sales
pnpm --filter @retailos/api exec tsx src/scripts/seed-demo-invoices.mts      # GST invoices
pnpm --filter @retailos/api exec tsx src/scripts/seed-demo-operations.mts    # POs, receipts, waste
pnpm --filter @retailos/api exec tsx src/scripts/seed-demo-engagement.mts    # alerts, history
```

A three-outlet Bengaluru café chain: 180 days of history, ~50k sales transactions, ~455k stock
movements, 75 GST tax invoices with real GSTIN/HSN/CGST-SGST across four distinct supplier layouts.

Three properties make it worth more than a fixture:

**It is deterministic.** Every draw comes from a seeded PRNG, and each store-day derives its own
stream from `(seed, store, date)` rather than sharing one sequential generator — so a day's data is
a pure function of its own key, independent of how many days were generated before it. Two runs
produce byte-identical output.

**Nothing is inserted directly.** Every row is written through the same repositories and services
the application uses: sales run recipe explosion → FEFO draw → movement posting; invoices go
through the real upload → confirm → approve pipeline; notifications come from calling the actual
rule engine and only firing where it returns `fires: true` (114 stock candidates evaluated, 2
fired). Stock levels are a genuine projection of the ledger — verified, not asserted.

**It contains deliberate imperfection.** One ingredient is left permanently unpriced, so a real menu
item reports **unknown** cost on screen and period-wide theoretical COGS honestly cannot be
computed. A supplier's on-time rate degrades from 100% to 57% across the window. Prices creep 13% on
one supplier's staples. A demo where every figure resolves proves nothing about the one rule this
system is built around.

`mock-data/findings/` documents each planted narrative with the figure it should produce, measured
from the generated corpus rather than hand-written.

---

## Scope boundaries

Deliberately **not** built: payment processing (PCI scope), general ledger, payroll, or tax
(regulated), autonomous supplier contact (liability), and machine learning wherever a deterministic
formula is correct and explainable.

"Profit" is never reported — rent, labour, and tax are outside the system's data boundary. The
number is **contribution margin**, and it's labelled as such.

---

## Roadmap

Not yet built: multi-organization login (an accountant with several clients gets an explicit
"not yet supported" error rather than a silently-picked tenant), per-channel notification retry and
dead-lettering, and a public REST API for integrations.

Deliberately deferred rather than missing: **email delivery is recorded but not sent** — a
notification fans out to real per-recipient, per-channel delivery rows, and the in-app channel is
marked delivered while email stays `PENDING`, because claiming a send that never happened is the
same class of lie as a fabricated number.
