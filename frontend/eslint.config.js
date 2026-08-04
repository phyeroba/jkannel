// ESLint flat config for the JKANNEL frontend (Vue 3 + TypeScript + Vite).
//
// Philosophy: this ruleset is deliberately PRAGMATIC. It enables the high-value
// correctness rules (unhandled promises, misused promises, unused symbols,
// await-on-non-thenable) and turns off / downgrades stylistic rules that would
// produce hundreds of findings nobody will action. Formatting is owned entirely
// by Prettier (see the eslint-config-prettier entry, which MUST stay last).
//
// Type-aware linting is enabled via `projectService`, which resolves each file
// through the nearest tsconfig (tsconfig.app.json for src/ + tests/,
// tsconfig.node.json for vite.config.ts).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // Nothing below this point should ever look at build output or vendored code.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.cache/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },

  js.configs.recommended,

  // Type-aware rules are scoped to TS/Vue only — plain .js tooling files (this
  // config included) are not in any tsconfig, and applying typed rules to them
  // makes ESLint fail to even start.
  {
    files: ['**/*.{ts,tsx,vue}'],
    extends: [...tseslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
  },
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ---------------------------------------------------------------------------
  // Parser wiring: .vue files need vue-eslint-parser at the top level, with
  // typescript-eslint's parser handling the <script lang="ts"> block.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Shared rule policy.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,vue}'],
    rules: {
      // --- High-value correctness. Kept at `warn` so CI is adoptable today;
      // --- promote to `error` once the outstanding findings are cleared.
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': [
        'warn',
        // Vue templates legitimately bind `@click="asyncHandler"`; flagging every
        // one of those is pure noise, so only the return-value case is checked.
        { checksVoidReturn: false },
      ],
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      'no-unused-private-class-members': 'error',

      // --- Real bugs, always hard errors.
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      eqeqeq: ['error', 'smart'],

      // `require-atomic-updates` is disabled for the frontend specifically: it
      // flags every `someRef.value = x` that follows an `await` (the standard
      // Vue "reset the busy flag in finally" idiom) as a race. Every one of the
      // ~30 hits in this app is a false positive — a Vue ref is a single-owner
      // reactive cell, not shared mutable state across concurrent tasks. It is
      // still enabled on the backend, where the analysis is meaningful.
      'require-atomic-updates': 'off',

      // --- Unused code. `warn`, not `error`, so that the genuine dead-code
      // --- findings stay visible without blocking CI. See the CI README notes.
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

      // --- Noisy-by-nature type-checked rules. This codebase talks to a REST API
      // --- whose payloads arrive as `any`/`unknown`; making these errors would
      // --- mean hundreds of findings in view components with no safety win.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'warn',

      // --- Vue: keep the correctness rules, drop the formatting-adjacent ones
      // --- that overlap with (or fight) Prettier.
      'vue/multi-word-component-names': 'off',
      'vue/attributes-order': 'off',
      'vue/order-in-components': 'off',
      'vue/attribute-hyphenation': 'off',
      'vue/v-on-event-hyphenation': 'off',
      'vue/require-default-prop': 'off',
      'vue/no-v-html': 'warn',
      'vue/no-unused-components': 'warn',
      'vue/no-unused-vars': 'warn',
    },
  },

  // ---------------------------------------------------------------------------
  // Node-side tooling files.
  // ---------------------------------------------------------------------------
  {
    files: ['*.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ---------------------------------------------------------------------------
  // Files that live outside the tsconfig project graph: playwright.config.ts is
  // not referenced by tsconfig.node.json, and e2e/ is excluded from
  // tsconfig.app.json. Type-aware linting cannot see them, so it is switched off
  // for these paths rather than mutating the app's tsconfig layout.
  // ---------------------------------------------------------------------------
  {
    files: ['playwright.config.ts', 'e2e/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false, project: false },
    },
  },

  // ---------------------------------------------------------------------------
  // Tests: unit specs and Playwright e2e. Assertions frequently poke at internals
  // and use non-null assertions; that is fine in a test.
  // ---------------------------------------------------------------------------
  {
    files: ['tests/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  // MUST be last: disables every ESLint rule that Prettier already owns so the
  // two tools cannot disagree about formatting.
  prettier,
);
