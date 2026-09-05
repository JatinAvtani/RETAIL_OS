import '@retailos/config/auto';

/**
 * Runs ONE investigation-trigger tick immediately, instead of waiting for the scheduled sweep.
 *
 * Exists because the sweep's real interval is 15 minutes, which is far too slow a feedback loop
 * when verifying that a finding actually reaches the Finance Controller feed — the thing the whole
 * proactive path exists to produce. Same processor the scheduler runs, no test double: whatever
 * this prints is exactly what the real tick would have done.
 */
const { createInvestigationTriggerProcessor } = await import('../investigation-trigger-processor');

// This sweep is cross-tenant by nature (it scans every org's notifications), so it needs the
// SWEEP/admin connection — exactly what `start.ts` passes it. The tenant-scoped `retailos_app`
// role cannot run it: an unscoped query under RLS fails with
// `unrecognized configuration parameter "app.current_org_id"`.
const databaseUrl = process.env.SWEEP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('No SWEEP_DATABASE_URL/DATABASE_URL in env.');
  process.exit(1);
}

const processor = createInvestigationTriggerProcessor({
  databaseUrl,
  geminiApiKey: process.env.GEMINI_API_KEY,
});

const result = await processor();
console.log('investigation trigger tick:', JSON.stringify(result));
process.exit(0);
