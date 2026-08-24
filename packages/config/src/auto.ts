import { loadEnv } from './load-env';

/**
 * Side-effect entrypoint: importing this module LOADS the env file, rather than merely exporting a
 * function that could.
 *
 * This exists because `apps/api` and `apps/worker` read `process.env` during module evaluation of
 * their transitive imports, which happens before any statement in their own entrypoint body. ES
 * imports are hoisted but their ORDER is preserved, so importing this first is the only construct
 * that reliably populates the environment in time — a `loadEnv()` call in the body would run too
 * late to matter.
 */
loadEnv();
