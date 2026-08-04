/**
 * Module boundaries: dependency-cruiser is the CI-enforced mechanism that keeps the modular
 * monolith modular.
 *
 * The "no reaching into another package's internals" rule is expressed as one explicit rule per
 * workspace package rather than a single generic regex: dependency-cruiser's `path`/`pathNot`
 * matching does not support backreferences between a rule's `from` and `to` capture groups (a
 * `to.pathNot` cannot refer back to what `from.path` matched), which was tried first and produced
 * false positives on ordinary same-package imports (e.g. quantity.ts importing unit.ts, both
 * inside packages/domain). Explicit per-package rules are more verbose but actually correct, and
 * at 8 workspaces the maintenance cost of adding one line when a new package is created is low.
 */
const WORKSPACES = [
  'apps/web',
  'apps/api',
  'apps/worker',
  'packages/domain',
  'packages/db',
  'packages/session',
  'packages/authz',
  'packages/storage',
  'packages/pos',
  'packages/metrics',
  'packages/ai',
  'packages/ui',
];

const noReachIntoRules = WORKSPACES.map((ws) => ({
  name: `no-reach-into-${ws.replace('/', '-')}-internals`,
  severity: 'error',
  comment:
    `Only ${ws}/src/index.ts (its public interface) may be imported from outside ${ws} - ` +
    'reaching into its internals directly means its internals can never change without ' +
    'breaking consumers, which defeats the point of having package boundaries at all.',
  from: { pathNot: `^${ws}/` },
  to: {
    path: `^${ws}/src/(?!index\\.ts$).+`,
  },
}));

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make module boundaries meaningless and complicate any future extraction into separate services.',
      from: {},
      to: { circular: true },
    },
    ...noReachIntoRules,
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(dist|drizzle|\\.test\\.ts$|\\.spec\\.ts$|\\.type-test\\.ts$)',
    },
  },
};
