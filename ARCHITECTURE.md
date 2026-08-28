# Architecture

Vyapaar ingests POS data, supplier invoices, and inventory activity, reconciles them into one
operational model, and answers a single question with citations:

> Connect your POS, upload three months of invoices, and within 48 hours we will show you —
> with line-item citations — where your margin went.

Every design decision below exists to make that answer **trustworthy**, which in this domain means
one thing: the system must never state a business number it cannot derive.

---

## The chain that makes the claim true

```
Invoice → SupplierPrice → Product cost → Recipe → MenuItem
                                            ↓
   Sales → consumption → COGS → Contribution margin → Metric → Answer
```

Break any link and the product cannot answer its headline question. Changes touching this chain are
high-risk by definition and carry property-based tests rather than example-based ones.

---

## Shape

A **modular monolith** in three processes, not microservices.

| Process | Runtime | Responsibility |
|---|---|---|
| `apps/web` | Next.js 15 (App Router) | SSR dashboards |
| `apps/api` | Fastify + tRPC | All reads and writes |
| `apps/worker` | BullMQ (9 workers) | POS sync, OCR, embeddings, aggregation, notifications, briefings |

Postgres 16 (pgvector, pg_trgm, FTS) · Redis · S3/MinIO. TypeScript strict throughout.
**14 packages, 3 apps, 52 migrations, 243 test files.**

### Why not microservices

Receiving goods atomically touches lots, movements, the stock projection, purchase-order state, and
the outbox. As separate services that is a distributed saga with compensating actions — for a
workflow with no independent scaling need. The split here is by **resource profile**, not domain
noun: OCR is bursty and external-bound, so it lives in the worker.

### Module boundaries

```
packages/domain    Pure business logic. No I/O. Costing, FEFO, reorder math, recipe explosion.
packages/db        Drizzle schema, migrations, repositories, RLS guards.
packages/metrics   The metric catalog — the ONLY place a business number is computed. 67 functions.
packages/ai        Every model call. Nothing outside imports a provider SDK.
packages/assistant Classify → plan → execute → ground → narrate.
packages/authz     Roles, permissions, AuthContext.
packages/session   Redis-backed opaque tokens, revocation, permission-change invalidation.
packages/config    Environment loading.
packages/integrations  Vendor sync ORCHESTRATION (composes packages/db + packages/pos) — shared
                        between apps/api (manual trigger, webhook) and apps/worker (the real job),
                        since apps cannot import each other.
packages/queue · storage · email · pos · ui
```

Boundaries are **CI-enforced** with `dependency-cruiser` (589 modules cruised). Cross-module writes
go through events only. A circular import fails the build — including type-only cycles, which
`tsc` accepts silently.

---

## The nine invariants

Each one, violated, produces **silently wrong business numbers** — the single failure this product
cannot survive. Most are machine-checked by `scripts/verify-invariants.sh` in CI.

| # | Invariant |
|---|---|
| **I1** | LLMs never compute a business number |
| **I2** | Every business number comes from a registered metric function |
| **I3** | `stock_movements` is append-only; corrections are new rows |
| **I4** | Every tenant-scoped query is org-scoped at 4 layers |
| **I5** | Money and quantity are decimal + branded types, never `number` |
| **I6** | Unit conversion is explicit, applied once, at a boundary |
| **I7** | Missing data degrades to "unknown", never to zero or a guess |
| **I8** | State change and event emission are one transaction (outbox) |
| **I9** | AI drafts; humans approve. AI has no write tools |

**I7 is the one well-intentioned code violates most.** `cost ?? 0` looks like defensive
programming; in a costing path it silently inflates margin and nothing appears broken.

---

## Deterministic core, probabilistic edge

The recurring decision in this codebase. Get the boundary wrong and the product's value evaporates.

| Deterministic (code + tests) | Probabilistic (models + validation) |
|---|---|
| All arithmetic, money, quantities | Document extraction (OCR) |
| Reorder quantities, FEFO allocation | Query → metric routing |
| Supplier performance, margin attribution | Answer narration |
| Anomaly **detection** (decomposition, z-score) | Anomaly **narration** |
| Recipe explosion | Fuzzy match **suggestions** (a human confirms) |

Rule of thumb: **if a wrong answer costs money or corrupts data, it is deterministic.**

### How the assistant stays honest

```
question → classify intent → plan (LLM picks metric IDs + params)
         → validate params against each metric's real Zod schema
         → reject any storeId or productId not in the caller's real lists
         → execute (deterministic, RLS-scoped, permission-gated)
         → grounding bundle → narrate → validate every number in the prose
```

The model chooses *which* metrics to call. It never computes a value, and it is never trusted with
an identifier — a `storeId` or `productId` it did not copy from the caller's real, org-scoped list is
rejected before execution. A product and its variant are validated as a **pair**, since a real
product id combined with another product's variant would pass two independent existence checks and
still compute a figure for something that does not exist. The prompt also states today's date, so a
relative period like "the last 7 days" is resolved rather than guessed from training data. Without that check an invented-but-valid UUID passes schema validation,
matches zero rows, and a summing metric reports `0.0000` as a real figure — a confident zero the
grounding validator cannot catch, because a metric value is exactly what its allowlist permits.

`validateGrounding` then checks every number in the generated prose against the metric values and
verbatim source passages. Anything else is a refusal, not an answer.

---

## Tenancy

Isolation holds at four layers: the SQL query, the cache key, the vector filter, and the job
payload. Postgres RLS is the backstop — **59 `ENABLE ROW LEVEL SECURITY` statements** across the
schema, with policies both `ENABLED` and `FORCED`.

The application connects as `retailos_app`, never as the `postgres` superuser. This is not a
convention: a superuser **silently bypasses RLS regardless of ENABLE/FORCE**, so connecting as one
would turn every policy into decoration. CI sets `APP_DATABASE_URL` to the scoped role for exactly
this reason.

A cross-tenant merge-gate suite covers **102 registered procedures**, asserting each denies another
tenant's resource while still reaching a genuine success on its own — the own-resource half matters
as much as the denial, because a procedure that 404s for everyone would pass a denial-only test.

---

## Time

- Times are `TIMESTAMPTZ`, stored UTC, presented in store timezone. A restaurant's "yesterday" is a
  local-time concept; dayparts computed in UTC are simply wrong.
- Movements are **bi-temporal**: `occurred_at` (business time) versus `recorded_at` (system time).
  A Monday delivery entered Wednesday belongs in Monday's history — and an invoice uploaded today
  but dated three months ago posts to its own date, which is what makes "upload three months of
  invoices" produce correct monthly COGS.

---

## Data

Master data is soft-deleted; ledger rows are never deleted. Partial unique indexes
(`WHERE deleted_at IS NULL`) let SKUs be reused. Pagination is keyset, never `OFFSET`.

The repository ships a deterministic **corpus generator**, not a dataset — a three-outlet Bengaluru
café chain, 180 days, ~50k sales and ~455k stock movements, seeded through the real repositories and
services rather than inserted directly. It contains deliberate imperfection: one ingredient is left
permanently unpriced, so a real menu item reports **unknown** cost on screen. A demo where every
figure resolves proves nothing about the one rule this system is built around.

---

## Testing

Financial and inventory calculations get **property-based tests** (fast-check) asserting invariants,
not just examples: stock never diverges from the ledger sum, recipe explosion conserves quantity,
FEFO never over-allocates a lot, margin components sum exactly to the total.

Concurrency bugs are proven against real Postgres before being fixed — two sessions each drawing 8
from a lot of 10 both succeeded and left it at **−6.000000** until `FOR UPDATE` plus a quantity
guard was added.

---

## Razorpay-native sources

No Razorpay integration is built or planned for this submission — Open Track asks for "a real
problem, a working product, meaningful use of AI, and evidence that it creates value," not a vendor
integration. This section maps Razorpay's own API surface onto the canonical model above, without
writing a line of adapter code, to show the design already generalizes to a payments-first data
source the same way it already generalizes across Square (a full working adapter, `packages/pos`)
and manual CSV upload.

| Razorpay object | Real fields (documented) | Maps to |
|---|---|---|
| **Items** (`/items`) | `name`, `amount`, `description` — no confirmed SKU/HSN field | `pos_items`, `mapping_status: 'UNMAPPED'` — same as a fresh Square catalog sync |
| **Invoice `line_items`** (`/invoices`) | `name`, `amount`, `quantity` — a real per-line array, up to 50 lines | `sales_transaction_lines` — the one Razorpay object with genuine item-level detail |
| **Payment** (`/payments`) | `amount`, `currency`, `method`, `status`, `order_id`; `description`/`notes` are free text, **no item-level breakdown at all** | `unmapped_sales` — quarantined by design, not degraded to a guess |

The Payment row is the interesting case, not the easy one. A UPI QR scan or a card-present payment
carries an amount and nothing else — no line items, no product reference. Feeding it through the
same pipeline as an itemized Invoice would either invent consumption for a sale with no known
composition, or silently drop real revenue. Neither is acceptable under I7 ("missing data degrades
to unknown, never to zero or a guess"): an amount-only Payment becomes a real `sales_transactions`
row with genuine revenue, and its lines land in `unmapped_sales` exactly like an unrecognized POS
SKU today — visible on the completeness tile, not silently absorbed into COGS. **This is the same
rule the rest of the system already lives by, applied to a data source that happens to be
Razorpay's rather than Square's — nothing about the architecture changes to accommodate it.**

**Why not build against the Razorpay MCP server directly?** It would hand the assistant raw
payment rows to reason over — exactly the boundary I1/I2 exist to hold. The whole point of the
metric catalog is that a business number has exactly one path to existing: a registered function,
computed deterministically, cited by id. A tool that lets the model read a table and narrate over
it collapses that path back to "the LLM computed something," which is the one failure mode this
architecture is built to make structurally impossible, not just discouraged.

**Why not integrate Razorpay POS instead of a payments API?** It is a device SDK issuing
POS-team-scoped keys with dashboard-only CSV export — not a merchant-pull API a backend service can
call on a schedule the way `syncSquareOrders`/`syncSquareCatalog` do today. The ingestion model this
system is built around (a scheduled pull plus a webhook, both idempotent, both retriable) doesn't
have an equivalent surface to attach to there.

---

## What is deliberately not built

No payment processing (PCI scope) · no general ledger, payroll, or tax (regulated) · no autonomous
supplier contact (liability) · no ML where a deterministic formula is correct and explainable · no
Kafka, Kubernetes, or Elasticsearch until a measured trigger fires.

"Profit" is never reported — rent, labour, and tax are outside the system's data boundary. The
number is **contribution margin**, and it is labelled as such.
