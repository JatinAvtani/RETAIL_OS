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
| `apps/worker` | BullMQ | POS sync, OCR, embeddings, aggregation, notifications |

Postgres 16 (pgvector, pg_trgm, FTS) · Redis · S3/MinIO. TypeScript strict throughout.
**13 packages, 3 apps, 52 migrations, 237 test files.**

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
packages/queue · storage · email · pos · ui
```

Boundaries are **CI-enforced** with `dependency-cruiser` (780 modules cruised). Cross-module writes
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
         → reject any storeId not in the caller's real store list
         → execute (deterministic, RLS-scoped, permission-gated)
         → grounding bundle → narrate → validate every number in the prose
```

The model chooses *which* metrics to call. It never computes a value, and it is never trusted with
an identifier — a `storeId` it did not copy from the caller's real, org-scoped store list is
rejected before execution. Without that check an invented-but-valid UUID passes schema validation,
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

A cross-tenant merge-gate suite covers **101 registered procedures**, asserting each denies another
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

## What is deliberately not built

No payment processing (PCI scope) · no general ledger, payroll, or tax (regulated) · no autonomous
supplier contact (liability) · no ML where a deterministic formula is correct and explainable · no
Kafka, Kubernetes, or Elasticsearch until a measured trigger fires.

"Profit" is never reported — rent, labour, and tax are outside the system's data boundary. The
number is **contribution margin**, and it is labelled as such.
