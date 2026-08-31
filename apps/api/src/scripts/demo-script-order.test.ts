import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootPackage = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../package.json'), 'utf8')
) as { scripts: Record<string, string> };

describe.each(['demo:quick', 'demo'])('%s seed ordering', (scriptName) => {
  it('creates purchase orders and receipts before attempting invoice matches', () => {
    const script = rootPackage.scripts[scriptName]!;
    expect(script.indexOf('seed-demo-operations.mts')).toBeGreaterThan(
      script.indexOf('seed-demo.mts')
    );
    expect(script.indexOf('seed-demo-invoices.mts')).toBeGreaterThan(
      script.indexOf('seed-demo-operations.mts')
    );
    expect(script.indexOf('seed-demo-engagement.mts')).toBeGreaterThan(
      script.indexOf('seed-demo-invoices.mts')
    );
  });
});
