# Extraction accuracy spike

Throwaway code, not production. The question: can a general-purpose vision model
(no paid document-AI provider — see constraint below) extract structured data from
a supplier invoice accurately enough to trust downstream cost/margin calculations?

## Why this matters

The product reads POS sales and supplier invoices to compute true cost and margin.
If invoice line items can't be extracted reliably, the cost data feeding every
number downstream is wrong. This spike answers that before any of the real
pipeline gets built.

## Constraint

No billing relationship with any provider (Document AI, Azure Document
Intelligence — both rejected, both require a card). Gemini's free API tier is the
only OCR/LLM path. Expect lower raw accuracy than a specialized document model —
the bet is that deterministic validation gates (arithmetic checks, price sanity,
duplicate detection) catch what the extractor gets wrong, so the architecture's
correctness doesn't depend on provider accuracy.

## What's here

```
src/fixtures.ts        7 hand-authored invoices (ground truth), covering multiple
                        supplier layouts, multi-page, discounts, credits, mixed
                        units, tax variation, and a near-duplicate pair
src/templates.ts        3 distinct HTML invoice layouts
src/gen-corpus.ts       renders fixtures to PDF (visual reference only)
src/gen-images.ts       renders fixtures to PNG (what the extractor actually reads)
src/degrade.ts          simulates a phone photo: rotation, crop, contrast, blur, JPEG compression
src/providers/gemini.ts vision extraction via structured JSON schema
src/run-extraction.ts   runs the harness against clean + degraded corpus
src/gates.ts            deterministic validation: line arithmetic, document total,
                         date sanity, duplicate detection, price-sanity (catches
                         decimal-place errors)
src/inject-errors.ts    injects known error classes into ground truth and measures
                         gate catch rate — the headline metric when the extractor
                         itself is imperfect
src/score.ts            field/line accuracy, confident-but-wrong rate, clean vs.
                         degraded gap, per-supplier breakdown
```

`corpus/` and `results/` are gitignored — generated artifacts, regenerate with the
scripts below.

## Running it

Needs `GEMINI_API_KEY` in the repo-root `.env.local` (free tier, no card — see
`aistudio.google.com/apikey`).

```
pnpm install
npm run gen-corpus       # PDFs (visual reference)
npm run gen-images       # PNGs (what extraction actually reads)
npm run degrade
npm run extract          # calls Gemini — slow on free tier, budget ~15-20 min
npm run score
npm run inject-errors    # no API calls, runs against ground truth directly
```

## Status

Corpus, degradation, harness, gates, and error injection are built and passing
against ground truth. Live extraction against the mock corpus is the next thing
to actually read results from — this corpus is synthetic and will overstate
real-world accuracy no matter what it scores; the honest answer needs 10-20 real
supplier invoices re-run through the same pipeline before any provider decision
is final.
