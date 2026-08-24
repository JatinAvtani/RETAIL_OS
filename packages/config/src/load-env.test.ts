import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './load-env';

/**
 * `loadEnv` is what makes the README's own quickstart work on a fresh clone — before it, nothing in
 * this repo read `.env.local` at all, and `pnpm --filter @retailos/db db:migrate` threw
 * `DATABASE_URL is required` on step 4.
 *
 * The precedence rule is the load-bearing part: a real environment variable must always win, or CI
 * (which sets `DATABASE_URL`/`APP_DATABASE_URL` explicitly and ships no `.env.local`) would start
 * behaving differently from what it is configured to do.
 */

let root: string;
const touched: string[] = [];

const setEnv = (key: string, value: string | undefined) => {
  touched.push(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retailos-env-'));
  // `findRepoRoot` walks up looking for this marker.
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
});

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

const writeEnvFile = (contents: string) => writeFileSync(join(root, '.env.local'), contents);

describe('loadEnv', () => {
  it('loads KEY=value pairs from .env.local at the repo root', () => {
    setEnv('RETAILOS_TEST_PLAIN', undefined);
    writeEnvFile('RETAILOS_TEST_PLAIN=hello\n');

    loadEnv(root);

    expect(process.env.RETAILOS_TEST_PLAIN).toBe('hello');
  });

  it('NEVER overwrites a real environment variable — this is what keeps CI behaving as configured', () => {
    setEnv('RETAILOS_TEST_PRECEDENCE', 'from-real-env');
    writeEnvFile('RETAILOS_TEST_PRECEDENCE=from-file\n');

    loadEnv(root);

    expect(process.env.RETAILOS_TEST_PRECEDENCE).toBe('from-real-env');
  });

  it('finds the repo root by walking up, so it works whatever directory a script runs from', () => {
    setEnv('RETAILOS_TEST_NESTED', undefined);
    writeEnvFile('RETAILOS_TEST_NESTED=found\n');
    const nested = join(root, 'apps', 'api', 'src', 'scripts');
    mkdirSync(nested, { recursive: true });

    loadEnv(nested);

    expect(process.env.RETAILOS_TEST_NESTED).toBe('found');
  });

  it('is a no-op when there is no .env.local — CI and production legitimately have none', () => {
    setEnv('RETAILOS_TEST_ABSENT', undefined);

    expect(() => loadEnv(root)).not.toThrow();
    expect(process.env.RETAILOS_TEST_ABSENT).toBeUndefined();
  });

  it('ignores comments and blank lines', () => {
    setEnv('RETAILOS_TEST_AFTER_COMMENT', undefined);
    writeEnvFile('# a comment\n\n   \nRETAILOS_TEST_AFTER_COMMENT=real\n');

    loadEnv(root);

    expect(process.env.RETAILOS_TEST_AFTER_COMMENT).toBe('real');
  });

  it('strips one matching pair of surrounding quotes, so quoted and bare values agree', () => {
    setEnv('RETAILOS_TEST_DQ', undefined);
    setEnv('RETAILOS_TEST_SQ', undefined);
    writeEnvFile('RETAILOS_TEST_DQ="quoted value"\nRETAILOS_TEST_SQ=\'single\'\n');

    loadEnv(root);

    expect(process.env.RETAILOS_TEST_DQ).toBe('quoted value');
    expect(process.env.RETAILOS_TEST_SQ).toBe('single');
  });

  it('keeps `=` characters inside a value — a connection string is the common case here', () => {
    setEnv('RETAILOS_TEST_URL', undefined);
    writeEnvFile('RETAILOS_TEST_URL=postgresql://u:p@localhost:5432/db?opt=1&other=2\n');

    loadEnv(root);

    expect(process.env.RETAILOS_TEST_URL).toBe('postgresql://u:p@localhost:5432/db?opt=1&other=2');
  });

  it('does not throw when no repo root can be found above the start directory', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'retailos-orphan-'));
    try {
      expect(() => loadEnv(orphan)).not.toThrow();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
