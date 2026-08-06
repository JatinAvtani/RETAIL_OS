# RetailOS

Operations intelligence for food-service retail — cafés, bakeries, and restaurants.

RetailOS reads POS sales and supplier prices, reconciles them against recipes and an append-only
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

| Situation | What most systems do | What RetailOS does |
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

**Identity & multi-tenancy** — signup, email verification, password + Google OAuth login,
invitations, password reset, role-based permissions, Redis-backed sessions with revocation.

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

**Metrics & dashboard** — net revenue, actual COGS from real lot costs, theoretical COGS from
recipes, cost variance, contribution margin, food cost percentage, and waste by reason — each a
registered, unit-tested function consumed through a single code path.

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
packages/metrics The metric catalog — the only place a business number is computed
packages/pos     POS vendor adapters and the canonical sales model
packages/authz   Permission model
packages/session Redis-backed sessions
packages/storage S3-compatible object storage
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

---

## Running it

```bash
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

---

## Scope boundaries

Deliberately **not** built: payment processing (PCI scope), general ledger, payroll, or tax
(regulated), autonomous supplier contact (liability), and machine learning wherever a deterministic
formula is correct and explainable.

"Profit" is never reported — rent, labour, and tax are outside the system's data boundary. The
number is **contribution margin**, and it's labelled as such.

---

## Roadmap

Not yet built: supplier invoice ingestion with document extraction and a review UI, purchase orders
and reorder suggestions, anomaly detection, and a grounded natural-language assistant that routes
questions to the metric catalog rather than computing answers itself.
