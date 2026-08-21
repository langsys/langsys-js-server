import { defineConfig } from 'vitest/config';

/**
 * Acceptance tests only.
 *
 * A separate config rather than a path filter, because the default config EXCLUDES
 * `tests/e2e` and an exclude wins over an explicit filter — `vitest run tests/e2e` under
 * the default config reports "No test files found".
 *
 * Why e2e is excluded by default: it drives a SvelteKit bundle that inlined `dist/` when
 * it was built, so under the default `include` it certified a frozen artifact. Neutering
 * `t()` in `src/` left all 12 tests green, which made the one suite SPEC §13 calls the
 * acceptance test incapable of failing on a source regression.
 *
 * Run via `npm run test:e2e`, which rebuilds `dist/` and then the example, in that order.
 * The suite additionally asserts artifact freshness before trusting a pass.
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/e2e/**/*.test.ts'],
        // Ports are fixed, and the app and mock API are shared across the file.
        fileParallelism: false,
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
});
