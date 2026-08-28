import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRefusal } from './refusal';
import type { GroundingBundle } from './grounding-bundle';

/**
 * `refusal.ts`'s own doc comment: "`remedy` is derived by matching each real reason string against
 * a small set of known, genuinely actionable gap classes... pattern-matched against the metric
 * catalog's own existing free-text `unknownReason` messages." That match is maintained by hand —
 * `refusal.test.ts` imports nothing from `@retailos/metrics`, so a metric author rewording an
 * `unknownReason` string (or adding a new one that matches none of the known classes) breaks the
 * remedy silently, with every existing test still green.
 *
 * This test closes that gap WITHOUT running 50+ metrics against seeded data (expensive, and the
 * actual computed value is not what's under test here — only the STRING is): it reads the real
 * catalog source files directly and extracts every literal `unknownReason` the catalog can
 * actually produce, then feeds each one through `buildRefusal` exactly as `narrate`'s own gap-
 * formatting path would. A reason string that starts silently falling through to the generic
 * remedy is a real regression this test is designed to catch — not a proof the remedy TEXT is
 * perfect, but a proof every real reason class still gets a specific, non-generic one.
 *
 * Deliberately source-level, not execution-level: `@retailos/metrics`'s catalog files are the one
 * real source of truth for what `unknownReason` strings exist (I2 applies to prose the same way it
 * applies to numbers — this must not become a second, hand-copied description of the same gap).
 */

const GENERIC_REMEDY = 'No specific fix is known for this — try rephrasing the question or asking about a narrower date range.';

const metricsSourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'metrics', 'src');

/** Every real `unknownReason` string/template literal in every registered metric's source, with
 * template interpolations collapsed to a placeholder (the STATIC prose around a dynamic value —
 * e.g. an id or count — is what `remedyForUnknownReason` actually pattern-matches against). */
const extractUnknownReasons = (dir: string): string[] => {
  const reasons: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      reasons.push(...extractUnknownReasons(full));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
    const content = readFileSync(full, 'utf8');
    const pattern = /unknownReason:\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3] ?? '';
      reasons.push(raw.replace(/\$\{[^}]*\}/g, 'X'));
    }
  }
  return reasons;
};

const bundleFor = (unknownReason: string): GroundingBundle => ({
  metrics: [
    {
      metricId: 'test_metric',
      value: 'unknown',
      unit: 'CURRENCY',
      period: { from: new Date('2026-08-01'), to: new Date('2026-08-31') },
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [],
      unknownReason,
    },
  ],
  passages: [],
  entities: [],
});

/**
 * Reason classes that are genuinely, deliberately generic — no specific actionable remedy exists
 * for them beyond "try different inputs." Listed explicitly (not silently skipped) so an author
 * adding a new reason string is forced to make a real decision: give it a specific remedy in
 * `refusal.ts`, or add it here with a reason why generic is honest. This list is intentionally
 * short — most reason classes in this catalog DO have a specific, actionable next step.
 */
const KNOWN_GENERIC_REASON_SUBSTRINGS = [
  'fewer than 14 days of completed sales', // sales_anomaly — remedy is "wait", not an action to take
  'fewer than 2 historical price points', // price_change_impact — same, no action fixes "not enough history yet"
  'fewer than 2 days of waste', // waste_spike — same
  'fewer than 2 po-linked receipts', // supplier lead time variance — same
  'fewer than 2 recorded prices', // supplier price variance — same
  'no significant price_change event', // nothing to project — not a data gap with a fix
  'no period in the requested series has a computable', // trend series — same "not enough history" shape
];

describe('refusal.ts vs. the real metric catalog — drift detection', () => {
  const realReasons = extractUnknownReasons(metricsSourceDir);

  it('found real unknownReason strings in the catalog source — a sanity check on the extraction itself', () => {
    // If this ever drops to 0, the path resolution or regex broke silently and the whole suite
    // below would pass vacuously — this guards against that.
    expect(realReasons.length).toBeGreaterThan(30);
  });

  it.each(realReasons.map((r) => [r] as const))('unknownReason %j maps to a specific remedy, or is an acknowledged generic case', (reason) => {
    const refusal = buildRefusal(bundleFor(reason), [], [], []);
    const remedy = refusal?.items[0]?.remedy;
    expect(remedy).toBeDefined();

    const isAcknowledgedGeneric = KNOWN_GENERIC_REASON_SUBSTRINGS.some((s) => reason.toLowerCase().includes(s));
    if (remedy === GENERIC_REMEDY && !isAcknowledgedGeneric) {
      throw new Error(
        `unknownReason ${JSON.stringify(reason)} fell through to the generic remedy and is not in KNOWN_GENERIC_REASON_SUBSTRINGS. ` +
          `Either refusal.ts's remedyForUnknownReason needs a new pattern for this reason class, or (if generic really is honest here) add a matching substring to KNOWN_GENERIC_REASON_SUBSTRINGS in this test with a reason why.`
      );
    }
  });
});
