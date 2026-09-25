/**
 * Assertions about the BUILT artifact, not the source.
 *
 * These exist because a build step can silently falsify a claim the source makes
 * correctly. The case that motivated the file: `src/context.ts` imports
 * `node:async_hooks`, and tsup 8 shipped it as bare `async_hooks` because
 * `removeNodeProtocol` defaults to true. Node and Bun tolerate the bare specifier, so
 * every test in this repo passed; **Deno rejects it outright** and Cloudflare Workers
 * require the prefix under `nodejs_compat`.
 *
 * The result was a package whose README, `engines` field and NAME all claim four
 * runtimes while the artifact ran on two. Nothing in the source was wrong, and no
 * source-level test could have caught it.
 *
 * Skipped with a loud message when dist/ is absent rather than passing vacuously.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const distEsm = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const distCjs = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const built = existsSync(distEsm) && existsSync(distCjs);

describe.skipIf(!built)('built artifact', () => {
    it('has actually been built (guards every assertion below)', () => {
        expect(built, 'dist/ is missing — run `npm run build`. These tests are vacuous without it.').toBe(true);
    });

    it('keeps the node: prefix on builtin imports in ESM', () => {
        const esm = readFileSync(distEsm, 'utf8');
        expect(esm).toMatch(/from ['"]node:async_hooks['"]/);
        // The negative half. Without it, a build emitting BOTH forms would pass.
        expect(esm).not.toMatch(/from ['"]async_hooks['"]/);
    });

    it('keeps the node: prefix on builtin requires in CJS', () => {
        const cjs = readFileSync(distCjs, 'utf8');
        expect(cjs).toMatch(/require\(['"]node:async_hooks['"]\)/);
        expect(cjs).not.toMatch(/require\(['"]async_hooks['"]\)/);
    });

    it('imports no Node builtin other than async_hooks', () => {
        // Every additional builtin narrows the runtimes this package can claim. If one
        // appears, it is a deliberate decision that should update the README's runtime
        // list — not something that arrives with a dependency bump.
        const esm = readFileSync(distEsm, 'utf8');
        const builtins = [...esm.matchAll(/from ['"]node:([a-z_/]+)['"]/g)].map((m) => m[1]);
        expect([...new Set(builtins)].sort()).toEqual(['async_hooks']);
    });

    it('does not bundle the base SDK singleton graph', () => {
        /**
         * The whole reason this package consumes `langsys-js-typescript/pure` rather than
         * the core's main entry: the main entry instantiates LangsysApp, Translations, the
         * shared miss queue and the shared auth header at module scope — module-global
         * state inside a server process, which is the one thing this package exists to
         * avoid.
         *
         * **Third version of this check. The first two could not do their job.**
         *
         * v1 asserted no bare `from 'langsys-js-typescript'` import. That cannot fail: the
         * core is a devDependency, so tsup inlines it and a real import produces no import
         * statement at all. Measured — 51,901 → 116,302 bytes with the assertion green.
         *
         * v2 greped for IDENTIFIERS (`LangsysAppAPI`, `sTranslations`) with a control that
         * those names exist in the core's published artifact. The TS lane found both holes:
         * minifiers mangle internal identifiers, so a fully-inlined graph can grep clean;
         * and a control reading the CORE's artifact checks their build, not ours, so it is
         * blind to anything this repo's bundler does.
         *
         * v3 uses STRING LITERALS, whose contents no minifier rewrites, chosen because the
         * graph pulls them unconditionally through `LangsysApp` — a marker from a corner the
         * entry never reaches would be absent for a reason unrelated to the property, which
         * is a pass proving nothing. `_dev_/singleton-guard.sh` establishes that these
         * markers DO appear by building a mutant through this repo's own config; it is not
         * asserted from the core's artifact here, because that was the v2 mistake.
         */
        const esm = readFileSync(distEsm, 'utf8');

        // Still asserted, for the day the core becomes a runtime dependency and external.
        // Not sufficient alone — see above.
        expect(esm).not.toMatch(/from ['"]langsys-js-typescript['"]/);

        const SINGLETON_MARKERS = [
            'LangsysAppAPI Error:',
            'langsys:translations',
            'discovery/hint',
            'X-Write-Grant',
            '__langsys_probe__',
        ];
        for (const marker of SINGLETON_MARKERS) {
            expect(esm, `dist contains "${marker}" — the singleton graph is bundled`).not.toContain(
                marker,
            );
        }

        // Second, mangling-proof and tree-shake-proof signal. Deliberately a ceiling rather
        // than a pin: brittle across dependency bumps, useful as corroboration. Measured with
        // `npm run test:singleton-guard`: 81,178 bytes clean, 156,095 with the graph bundled, so
        // the ceiling sits between them.
        expect(esm.length).toBeLessThan(115_000);
    });

    it('declares no module-level mutable catalog state', () => {
        // A weak but cheap structural check: the package's central invariant is that
        // nothing request-varying lives outside the AsyncLocalStorage scope.
        const esm = readFileSync(distEsm, 'utf8');
        expect(esm).toMatch(/new AsyncLocalStorage\(\)/);
    });
});

describe.skipIf(built)('dist is missing', () => {
    it('reports that the build-output checks did NOT run', () => {
        // "The check did not run" and "the check passed" must not print the same.
        expect(built, 'dist/ absent: build-output conformance was NOT verified this run').toBe(false);
    });
});
