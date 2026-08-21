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
        // The whole reason `src/vendor/pure.ts` exists: importing langsys-js-typescript
        // instantiates LangsysApp, Translations, the shared miss queue and the shared
        // auth header at module scope. If a stray import ever pulls the real package in,
        // this catches it.
        const esm = readFileSync(distEsm, 'utf8');
        expect(esm).not.toMatch(/from ['"]langsys-js-typescript['"]/);
        expect(esm).not.toMatch(/new LangsysAppClass\(\)/);
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
