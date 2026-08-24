import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Loads `.env.local` from the repository root into `process.env`, for scripts run directly.
 *
 * Nothing in this repo loaded env files at all: there was no `dotenv` dependency and no
 * `--env-file` flag anywhere, so the README's own step 4
 * (`pnpm --filter @retailos/db db:migrate`) threw `DATABASE_URL is required` on a fresh clone.
 * Every contributor had to already know to export the variables by hand — which is precisely the
 * knowledge a fresh clone does not have.
 *
 * Implemented by hand rather than adding `dotenv`: this needs to run before any other import can
 * read `process.env`, the format in use here is a handful of `KEY=value` lines, and adding a
 * runtime dependency to parse them would be the larger change. Node's built-in `--env-file` was
 * tried first and rejected — it is rejected inside `NODE_OPTIONS`, and passing it as a direct flag
 * requires hardcoding a pnpm-internal path to the `tsx` binary, which is brittle across installs.
 *
 * **Real environment variables always win.** A value already present in `process.env` is never
 * overwritten, so CI (which sets `DATABASE_URL`/`APP_DATABASE_URL` explicitly and has no
 * `.env.local`) behaves exactly as before, and a one-off `FOO=bar pnpm ...` override still works.
 *
 * A missing `.env.local` is not an error — CI and production legitimately have none. The caller
 * still fails with its own clear message if a variable it needs is genuinely absent.
 */

const parseEnvFile = (contents: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;

    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes, so `KEY="value"` and `KEY=value` agree.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
};

/** Walks up from `startDir` looking for a directory containing `pnpm-workspace.yaml` — the repo root. */
const findRepoRoot = (startDir: string): string | null => {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

export const loadEnv = (startDir: string = process.cwd()): void => {
  const root = findRepoRoot(startDir);
  if (!root) return;

  const envPath = join(root, '.env.local');
  if (!existsSync(envPath)) return;

  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(envPath, 'utf8')))) {
    // Never clobber a real environment variable — see the note above on CI and one-off overrides.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};
