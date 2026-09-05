# Razorpay AI Buildathon — submission brief

**Track:** AI Finance Controller

**Product:** Vyapaar
**One sentence:** An operations-intelligence system that shows a food-service owner where margin
leaked, while making it structurally impossible for the AI layer to invent the financial numbers.

This is the source document for the form and video. Replace the two link placeholders only after
the final artifacts exist; do not improvise different claims in the submission form.

- **Repository:** https://github.com/JatinAvtani/RETAIL_OS
- **Pitch video:** `[ADD FINAL UNLISTED VIDEO URL]`
- **Hosted demo:** `[ADD URL IF DEPLOYED — otherwise use the reviewer quickstart]`

## The problem and the demonstrated value

Small cafés and restaurant groups know revenue, but usually cannot reconcile POS sales, recipes,
supplier prices and physical stock well enough to explain margin loss. A missing ingredient price
often becomes zero in ordinary software, making incomplete cost data look like excellent margin.

Vyapaar keeps unknown values unknown, reports data completeness beside the metrics, and traces a
figure from dashboard → metric execution → source tables → invoice or ledger rows. The canonical
deterministic demo corpus contains three Bengaluru outlets, 180 days of trading, 42,875 sales
receipts, 91,065 sale lines, roughly 455,000 stock movements and 75 GST invoices. It deliberately
includes an unpriced
ingredient, supplier price creep, declining delivery reliability, waste and receipt discrepancies
so the product must handle imperfect evidence rather than a cherry-picked clean case.

## The finance-ops loop this closes

The track asks for an agent that closes one finance-ops loop across a batch of records, reporting
its match rate and the exceptions it could not resolve. That loop here is **invoice reconciliation**:

- Every posted supplier invoice line is matched against its purchase order and the goods receipt
  that recorded what physically arrived — the same three-way match the production posting path runs
  at real posting time, not a demo-only re-implementation.
- The **batch reconciliation report** aggregates that already-persisted output into a measured match
  rate over a real batch — comfortably past the brief's 50-record floor, and growing as more invoices
  post — plus every unresolved exception ranked by dollar impact, with the supplier, product and
  variance type for each. The line count is deliberately not quoted as a fixed figure here: it is
  whatever the seeded corpus has actually posted at the moment the report runs, and the screen states
  it directly.
- The rate is reported as whatever the data actually is. A low rate means the corpus genuinely
  contains quantity discrepancies between what was invoiced and what was received — which is the
  finding the tool exists to surface, not a number to be tuned upward.

Around that loop sits a **bounded multi-hop investigation agent**. A finding — detected by a
scheduled sweep, with no question asked first — opens an investigation that decides whether one
metric answers it or whether it needs a follow-up hop, up to a fixed cap. Every hop's narration is
independently grounding-validated before it is stored, and each hop's input is the *validated* prior
narration, never raw model output, so a bad inference cannot compound across hops. An investigation
that reaches a root cause can end in a **draft action** — a reorder purchase order or a supplier
price-variance flag — whose quantities and prices come entirely from existing domain functions. The
model drafts; a human approves; only that separate, explicit approval call writes anything. The
model is given no write tool at any point.

## Why the AI is meaningful

The model is used where probabilistic interpretation helps:

- extracting inconsistent supplier invoices, with deterministic validation afterward;
- classifying a natural-language question and selecting registered metrics;
- deciding whether an investigation needs another hop, and framing the follow-up question;
- retrieving relevant document passages;
- narrating already-computed results.

It is deliberately not used for money arithmetic, inventory allocation, reorder quantities,
three-way matching, match-rate computation, dollar-impact ranking or anomaly detection. Those
operations are deterministic code. Before narration
reaches the user, every numeric token must match a computed metric or occur verbatim in retrieved
source text. One stricter regeneration is allowed; a second violation discards the prose and returns
the structured results. The assistant has no write tools.

The browser is a thin client: it cannot query Postgres or decide which figures are valid. A normal
dashboard read resolves the signed-in tenant at the API, executes a registered metric and returns
its value with freshness and completeness metadata. A purchase-order approval additionally checks
role, approval limit and optimistic versioning. The assistant follows the same trusted metric path,
then validates any prose against those already-computed facts.

## Build quality and failure recovery evidence

- Postgres row-level security, transaction-local tenant context, scoped repositories and a real
  cross-tenant endpoint attack suite enforce isolation at four layers.
- The stock ledger is append-only at the database permission layer; corrections are compensating
  movements.
- State change, outbox event and audit record are committed together.
- Duplicate imports, webhooks and document approvals are idempotent.
- Missing data produces a visible unknown state, never a zero or partial sum.
- Provider failure removes optional narration while preserving deterministic facts.
- CI runs typechecking, linting, dependency-boundary checks, invariant scans and integration tests
  against real Postgres, Redis and MinIO.

## Honest scope at submission time

- The evaluation corpus is deterministic and synthetic; it demonstrates seeded failure modes, not
  measured customer outcomes.
- The repository has not been load-tested and should not be described as production-ready.
- Outbound supplier and notification email is mocked; no claim depends on a real delivered email.
- Razorpay payment processing is not part of this build; the finance-ops loop closed here is
  invoice-to-receipt reconciliation, not payments.
- The reconciliation match rate over the demo corpus is low, and is reported unchanged. The
  discrepancies are real ones seeded into the corpus; raising the number would mean fabricating
  agreement between invoices and receipts, which is the exact failure this project is built to
  prevent.
- The proactive investigation sweep is rate-limited by the model provider's free tier, so it paces
  itself to a small batch per tick. A large backlog therefore drains over several ticks rather than
  all at once.
- A hosted URL is optional only if the reviewer quickstart is freshly verified and the five-minute
  video shows the product working without edits or hidden setup.

## Reviewer-path verification record

Verified locally against real Postgres, Redis and MinIO on 31 August 2026:

- both migration phases completed;
- the atomic organization-bootstrap rollback regression passed against Postgres;
- the bounded seed completed with 3 stores, 420 sales, 852 consumed lines and 4 deliberately
  quarantined unmapped lines;
- the remaining stages produced 75 posted documents, 40 purchase orders/goods receipts, stocktake,
  transfer and waste history, plus notification rules/delivery attempts;
- an independent database query confirmed the 3/420/75/40 store, sale, document and PO counts;
- all 75 invoice matches link to a purchase order, with zero unmatched rows; the largest persisted
  received quantity is 4 order units, confirming that pack/base-unit conversion is applied before
  variance comparison; and
- the browser reviewer path opened the rebuilt variance queue and a detail view with human-scale
  comparisons such as 3 invoiced / 3 received and working purchase-order drill-through; and
- a real API password login returned HTTP 200 and a secure session cookie for the demo owner.

This record is evidence for the final pre-submission run, not a substitute for re-running the fresh-
clone checklist after the last commit.

## The failure story to tell

During testing, two concurrent inventory consumers could each read a lot of 10 units and both draw
8, leaving the lot at `-6.000000`. The fix was not a prompt or a retry: the allocation path now locks
the relevant rows and guards the remaining quantity inside the transaction. This is the best concise
example of the project’s engineering posture: reproduce the money-affecting failure against the real
database, fix the invariant at the layer that owns it, then keep the regression test.

A second useful story is the supplier-impact unit bug: a per-pack price increase was multiplied by
a base-unit quantity, inflating annualised impact by roughly 25,000× for a 25 kg sack. A conversion-
aware regression test now covers the non-unit pack case.

## Five-minute video script (target 4:35)

| Time | Beat |
|---|---|
| 0:00–0:15 | Open on one measured exception or margin finding. State the owner problem in one sentence. |
| 0:15–0:45 | Show the dashboard and the completeness/unknown state. Explain why zero would be dangerous. |
| 0:45–1:15 | Open a supplier invoice: extracted fields → validation evidence → posted inventory/price. |
| 1:15–1:45 | Open the three-way-match variance queue and trace one exception. |
| 1:45–2:25 | Ask the assistant a sales or supplier question; expand provenance and drill into a source. |
| 2:25–2:45 | Show graceful failure: missing evidence or unavailable model returns facts/unknown, not invented prose. |
| 2:45–3:20 | One architecture view: deterministic core, probabilistic edge, metric catalog as the sole number path. |
| 3:20–3:55 | Show tenant/RLS, append-only ledger and numeric validator as brief code evidence. |
| 3:55–4:20 | Tell the concurrent `-6.000000` lot bug and its transaction-level fix. |
| 4:20–4:35 | State honest limits: synthetic corpus, mocked outbound email, no payment processing. Close on the repo. |

Do not spend video time listing features. Keep one uninterrupted chain: source document → validated
state → computed finding → grounded explanation.

## Form-answer draft

### What did you build?

Vyapaar is an operations-intelligence platform for cafés, bakeries and restaurants. It reconciles
POS sales, recipes, supplier invoices and an append-only stock ledger to show where contribution
margin changed and which operational event caused it. Every number is drillable, and incomplete
inputs stay visibly unknown instead of becoming a misleading zero.

### How is AI used?

AI handles document interpretation, question routing, retrieval and narration. It never performs
financial arithmetic or mutates business state. A registered metric catalog computes every business
number, and a deterministic validator rejects narration containing unsupported figures. This makes
the model useful at the ambiguous edges without making it the authority for money.

### What broke, and how did you recover?

A concurrency test proved that two simultaneous stock consumers could drive a lot from 10 units to
`-6.000000`. I reproduced the race against Postgres, then fixed it with row locking and a quantity
guard in the transaction, adding a regression test. Separately, I found a pack/base-unit mismatch
that inflated a supplier price-impact figure by roughly 25,000×; the fix made conversion explicit
and added a non-unit-pack test. Both failures reinforced the same rule: financially significant
correctness belongs in deterministic, tested code—not in prompts.

### What evidence shows value?

The reproducible corpus models three Bengaluru outlets over 180 days with 42,875 sales receipts,
91,065 sale lines, approximately 455,000 stock movements and 75 GST invoices. It contains
deliberately planted but measured
problems: an unpriced ingredient, supplier price increases, delivery-reliability decline, expiry
waste and invoice/receipt mismatches. Vyapaar surfaces these through the same repositories, ledger,
metric catalog and review queues used by the application; the data is not inserted directly into
dashboard result tables.

## Final manual checklist

- [ ] Latest public CI run is green.
- [ ] Fresh-clone `pnpm demo:quick` and `pnpm dev` complete successfully.
- [ ] Demo opens in an incognito browser and **Explore with sample data** works.
- [ ] Every numeric claim in the video is rechecked against the final seeded database.
- [ ] Video is no longer than 5:00 after upload and plays without authentication.
- [ ] Repository is public and contains no secrets or `.env.local`.
- [ ] Replace the video/hosted-demo placeholders above.
- [ ] Paste reviewed answers into the form; do not edit the code after final submission.
