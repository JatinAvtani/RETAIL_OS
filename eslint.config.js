// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // spikes/** is deliberately disposable/no-architecture code (see spikes/extraction/README.md)
    // and isn't held to the same lint bar as packages/apps.
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/drizzle/**', '**/*.tsbuildinfo', 'spikes/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // noUnusedLocals/Parameters in tsconfig.base.json already cover this at the type-check
      // level; avoid duplicate, sometimes-conflicting reports from both tools.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    // CommonJS config files (dependency-cruiser doesn't support ESM config yet).
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  }
);
