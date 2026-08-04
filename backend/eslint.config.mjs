// ESLint flat config for the JKANNEL backend (NestJS + TypeScript).
//
// Philosophy: this ruleset is deliberately PRAGMATIC. The backend has ~76 spec
// files and a large amount of service code that talks to Postgres/Redis through
// loosely-typed drivers. A maximalist typescript-eslint config would emit
// thousands of `no-unsafe-*` findings against `pg` result rows alone, which
// nobody would ever action. So:
//
//   * high-value CORRECTNESS rules are on (floating promises, misused promises,
//     await-thenable, unused symbols, race-prone assignments);
//   * rules whose findings are dominated by driver-`any` noise are off;
//   * anything Prettier already owns is disabled via eslint-config-prettier,
//     which MUST remain the last entry in this array.
//
// Rules currently set to `warn` rather than `error` are the ones with real
// outstanding findings in the tree. They are intentionally NOT silenced —
// promote each to `error` once its findings are cleared.
//
// The file is `.mjs` because the backend package is CommonJS ("type" is unset)
// and ESLint flat config is ESM.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.js', '*.cjs'],
  },

  js.configs.recommended,

  // Type-aware linting, scoped to TypeScript only. tsconfig.json has no
  // `include`, so it covers src/ and tests/ from the package root.
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ---------------------------------------------------------------------
      // High-value correctness. These catch real defect classes in an async
      // NestJS service: dropped promises, `if (asyncFn())`, `await` on a
      // non-thenable, and reads of state that a concurrent task may have moved.
      // ---------------------------------------------------------------------
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // Plain-ESLint correctness rules that are cheap and almost never wrong.
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-optional-chaining': 'error',
      // `warn`, not `error`: both current hits are the benign
      // `new Promise((r) => setTimeout(r, ms))` sleep idiom, where the returned
      // timer handle is simply discarded. Kept on so a genuinely dangerous
      // executor return (e.g. returning a promise) still shows up.
      'no-promise-executor-return': 'warn',
      'require-atomic-updates': 'warn',
      eqeqeq: ['error', 'smart'],
      // The single current hit (api-key-auth.guard.ts) is a deliberate
      // rethrow whose only purpose is to carry an explanatory comment about why
      // unauthenticated calls are not written to gateway_request_log. Downgraded
      // rather than removed so the comment survives; still on to catch the real
      // `catch (e) { throw e }` mistake elsewhere.
      'no-useless-catch': 'warn',

      // ---------------------------------------------------------------------
      // Driver-`any` noise. `pg` rows, Redis replies and JSON bodies all arrive
      // as `any`; these rules would fire thousands of times with no safety win
      // until the data layer grows real row types. Revisit then.
      // ---------------------------------------------------------------------
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'warn',

      // Stylistic / low-signal.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      // This package compiles to CommonJS ("module": "commonjs"), so
      // `import X = require('x')` is the correct interop form for CJS-only deps
      // such as pdfkit, and `require()` inside specs is idiomatic. The rule
      // assumes an ESM target and does not apply here.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Specs and integration tests: same correctness bar, but the test-only
  // ergonomics (non-null assertions, empty stub bodies) are allowed.
  {
    files: ['**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      'require-atomic-updates': 'off',
    },
  },

  // MUST be last: turns off every rule Prettier already enforces.
  prettier,
);
