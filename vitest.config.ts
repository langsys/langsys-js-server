import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        // `tests/e2e` is EXCLUDED from the default run, and that is a correctness fix
        // rather than a speed one.
        //
        // The e2e suite drives `example/build/index.js`, a SvelteKit bundle that inlined
        // `dist/` at its last build. So it measures a frozen artifact: neutering `t()` in
        // `src/` and running it still reports 12 passed. Under the default `include` that
        // green appeared in every `npm test`, which made the SPEC §13 acceptance test —
        // the one the spec calls the thing everything else supports — incapable of failing
        // on a source regression.
        //
        // It now runs only via `npm run test:e2e`, which rebuilds `dist/` AND the example
        // first, and the suite additionally asserts artifact freshness before trusting a
        // pass. See `tests/e2e/example.test.ts`.
        exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
        // The core is inlined, and its `intl-messageformat` deduped to THIS package's copy.
        // Together they make the suite format with the copy the shipped bundle uses: `tsup`
        // inlines the core, so its `import 'intl-messageformat'` resolves from this package's
        // dependencies, while a core loaded natively from its sibling checkout resolves the
        // core's own, different version. They also let a test's `vi.mock` of the formatter
        // reach the core, which the ICU-6 forced-failure tests depend on.
        server: { deps: { inline: [/langsys-js-typescript/] } },
    },
    resolve: { dedupe: ['intl-messageformat'] },
});
