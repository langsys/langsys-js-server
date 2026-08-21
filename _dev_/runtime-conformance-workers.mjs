/**
 * Cloudflare Workers leg of the cross-runtime conformance suite.
 *
 * Workers is the runtime most likely to break this package and the least likely to be
 * noticed breaking, because nobody has one running locally by default. It is also the
 * runtime that most justifies the `-server` name over `-node` (SPEC §11).
 *
 * Two things make it different from the node/deno/bun legs:
 *
 *  1. **workerd cannot resolve `node_modules`.** The dist imports `parse5` and
 *     `intl-messageformat`, so the whole graph has to be bundled into one module first —
 *     which is what a real Workers user's build step does anyway.
 *  2. **`node:async_hooks` only exists under the `nodejs_compat` flag.** It is kept
 *     external through the bundle so the import survives verbatim and workerd resolves
 *     it at runtime. If the flag were missing, this fails at module load — which is the
 *     correct, loud failure.
 *
 * Emits the same `###REPORT###` line as the other legs so the driver can diff digests.
 */

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { runtime as _unused } from './runtime-conformance.mjs'; // eslint-disable-line no-unused-vars

const root = fileURLToPath(new URL('..', import.meta.url));

const WORKER_ENTRY = `
import { runConformance } from ${JSON.stringify(root + '_dev_/runtime-conformance.mjs')};
import * as mod from ${JSON.stringify(root + 'dist/index.mjs')};

export default {
    async fetch() {
        try {
            const report = await runConformance(mod);
            return new Response(JSON.stringify(report), {
                headers: { 'content-type': 'application/json' },
            });
        } catch (err) {
            return new Response(
                JSON.stringify({ fatal: String(err && err.stack || err) }),
                { status: 500, headers: { 'content-type': 'application/json' } },
            );
        }
    },
};
`;

async function main() {
    // Bundle exactly as a Workers user would: worker conditions, ESM, node builtins
    // left external so `nodejs_compat` provides them.
    let bundled;
    try {
        const result = await build({
            stdin: { contents: WORKER_ENTRY, resolveDir: root, sourcefile: 'worker-entry.js', loader: 'js' },
            bundle: true,
            format: 'esm',
            target: 'es2022',
            platform: 'neutral',
            conditions: ['workerd', 'worker', 'browser', 'import'],
            mainFields: ['module', 'main'],
            external: ['node:*'],
            write: false,
        });
        bundled = result.outputFiles[0].text;
    } catch (err) {
        console.error('###FATAL### bundling for workerd failed:', err.message);
        process.exit(1);
    }

    // Positive evidence the bundle is real before we blame the runtime for anything.
    if (!bundled.includes('node:async_hooks')) {
        console.error(
            '###FATAL### the bundle lost the `node:async_hooks` specifier. Workers requires the ' +
                'prefix under nodejs_compat; a bare `async_hooks` will not resolve.',
        );
        process.exit(1);
    }

    const mf = new Miniflare({
        modules: true,
        script: bundled,
        // `nodejs_compat` is what provides node:async_hooks. Without it the worker fails
        // at module load, which is the honest failure rather than a silent degradation.
        compatibilityFlags: ['nodejs_compat'],
        compatibilityDate: '2024-09-23',
    });

    try {
        const response = await mf.dispatchFetch('http://localhost/');
        const body = await response.json();

        if (body.fatal) {
            console.error('###FATAL### worker threw:', body.fatal);
            process.exit(1);
        }

        console.log('###REPORT###' + JSON.stringify(body));
        process.exitCode = body.failed > 0 ? 1 : 0;
    } catch (err) {
        console.error('###FATAL### dispatch failed:', err.message ?? err);
        process.exitCode = 1;
    } finally {
        await mf.dispose();
    }
}

await main();
