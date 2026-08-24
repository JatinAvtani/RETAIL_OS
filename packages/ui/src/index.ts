/**
 * Intentionally empty — this is NOT an abandoned or half-finished package.
 *
 * The shared component library lives at `apps/web/src/components/ui.tsx` instead, and every screen
 * imports it from there as `@/components/ui`. That is deliberate: there is exactly ONE consumer of
 * these components (`apps/web`), and a single-consumer "shared" package buys nothing but an extra
 * build step, an extra `tsc --build` edge, and a stale-`dist` failure mode every time a component
 * changes — a real cost this repo has already paid on other packages (see the project's own
 * TS-project-references staleness notes).
 *
 * This workspace is kept rather than deleted because removing it would touch the lockfile,
 * `apps/web/tsconfig.json`'s project references, and `.dependency-cruiser.cjs`'s workspace list —
 * more churn than an empty file costs. It becomes real the moment a SECOND consumer appears (a
 * marketing site, an admin app, a Storybook host); until then, moving components here would be
 * indirection with no beneficiary.
 *
 * If you are here because `apps/web` still lists `@retailos/ui` as a dependency: that is the one
 * genuinely misleading part, and it is load-bearing for the tsconfig project reference above.
 */
export {};
