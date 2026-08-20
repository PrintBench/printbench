import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import next from '@next/eslint-plugin-next'

/**
 * Flat config for the whole monorepo.
 *
 * Deliberately not type-aware: the type-checked rule set needs a program per
 * package and roughly triples lint time, and `npm run typecheck` already runs
 * the real compiler over everything. Lint is here to catch what the compiler
 * does not — unused code, floating state, React rules.
 */
export default tseslint.config(
  {
    /*
     * reference/ is AGPL and must never be linted, imported or built. Keeping
     * it out here as well as in tsconfig and .dockerignore means no tool has a
     * reason to walk into it.
     */
    ignores: [
      'reference/**',
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      'demo-library/**',
      'data/**',
      'packages/*/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      /*
       * The TypeScript compiler already reports genuinely unused locals. What
       * lint adds is the convention that a deliberately ignored binding is
       * prefixed with an underscore, so "unused" reads as intent.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      /*
       * Warn, not error. There are legitimate `any`s at the edges — pg row
       * shapes, third-party callbacks — and making this fatal encourages
       * casting through `unknown` for no gain.
       */
      '@typescript-eslint/no-explicit-any': 'warn',

      // A non-null assertion is often the honest reading of a `LIMIT 1` query
      // or an index we have just bounds-checked.
      '@typescript-eslint/no-non-null-assertion': 'off',

      /*
       * Off. `void somePromise()` is this codebase's deliberate marker for a
       * fire-and-forget, used in event handlers and effects where returning the
       * promise would be wrong. Flagging it pushes people towards dropping the
       * promise silently instead, which is the thing actually worth avoiding.
       */
      'no-void': 'off',
      'require-atomic-updates': 'off',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': next },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,

      /*
       * Warn, not error.
       *
       * This rule comes from the React Compiler ruleset and is stricter than
       * several patterns here that are correct and have no better spelling:
       * the `mounted` hydration guard next-themes requires, the
       * IntersectionObserver feature-detect fallback in the viewer, the
       * debounced search effects, and syncing a controlled input from a prop
       * that changes on navigation. Every current report is one of those.
       *
       * rules-of-hooks and exhaustive-deps stay fatal — those catch real bugs.
       */
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  {
    // Node scripts and the worker run outside the browser; console output is
    // how they report, not a leftover debug statement.
    files: ['scripts/**/*.mts', 'apps/worker/**/*.ts', 'packages/db/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__fixtures__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests deliberately build malformed values to prove they are refused.
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
)
