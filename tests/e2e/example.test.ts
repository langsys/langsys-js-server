/**
 * End-to-end against the example SvelteKit app.
 *
 * Everything else in this repo tests the package in isolation. This tests the thing the
 * package actually claims: **a crawler fetching `/it` receives Italian body copy in the
 * served HTML.** SPEC §13 calls that the acceptance test and says everything else is
 * supporting work.
 *
 * It runs against the BUILT adapter-node output, not the dev server, because the defect
 * this package exists to fix was a production-build defect.
 *
 * Skips loudly when the example is not built. "The check did not run" and "the check
 * passed" must not print the same — which is the failure class this whole project is
 * downstream of.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const exampleDir = `${repoRoot}/example`;
const exampleEntry = `${exampleDir}/build/index.js`;
const distEntry = `${repoRoot}/dist/index.mjs`;
const built = existsSync(exampleEntry);

/**
 * Newest mtime under a directory, ignoring build output and dependencies.
 */
function newestMtime(dir: string, skip: RegExp = /node_modules|\.svelte-kit|[/\\]build[/\\]/): number {
    let newest = 0;
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = `${current}/${entry.name}`;
            if (skip.test(full)) continue;
            if (entry.isDirectory()) walk(full);
            else newest = Math.max(newest, statSync(full).mtimeMs);
        }
    };
    walk(dir);
    return newest;
}

const API_PORT = 5591;
const APP_PORT = 5590;
const APP = `http://localhost:${APP_PORT}`;
const API = `http://localhost:${API_PORT}`;

let mockApi: ChildProcess;
let app: ChildProcess;

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch (err) {
            lastError = err;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

/** Visible body text, the same way the original defect was measured. */
function visibleBodyText(html: string): string {
    const body = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    return body
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

beforeAll(async () => {
    if (!built) return;

    mockApi = spawn('node', ['mock-api/server.mjs', String(API_PORT)], {
        cwd: exampleDir,
        stdio: 'ignore',
    });
    app = spawn('node', ['build/index.js'], {
        cwd: exampleDir,
        stdio: 'ignore',
        env: {
            ...process.env,
            PORT: String(APP_PORT),
            ORIGIN: APP,
            LANGSYS_API_URL: `${API}/api`,
            // Long TTL so caching assertions are not racing a 5s expiry.
            LANGSYS_TTL: '300',
        },
    });

    await waitFor(`${API}/__test__/fetch-counts`);
    await waitFor(APP);
}, 60_000);

/** Kill a child and WAIT for it to actually exit, so it releases its port. */
function stop(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const done = (): void => {
            clearTimeout(force);
            resolve();
        };
        // SIGKILL if it has not gone in a second, so a wedged child cannot hang the run.
        const force = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
        }, 1000);
        child.once('exit', done);
        child.kill();
    });
}

afterAll(async () => {
    // `kill()` without awaiting exit is why this suite failed roughly one run in three on
    // repeat: the previous run's children still held 5590/5591, and the next run reported
    // a confusing ECONNREFUSED rather than "the port is busy".
    await Promise.all([stop(mockApi), stop(app)]);
});

describe.skipIf(!built)('the artifacts under test are current', () => {
    /**
     * The acceptance suite drives a SvelteKit bundle that **inlined `dist/` when it was
     * built**. So it can certify a frozen artifact: neutering `t()` in `src/` and running
     * this suite against a stale `example/build` still reports every test green.
     *
     * That made the one suite SPEC §13 calls the acceptance test incapable of failing on
     * a source regression — a check that produces no signal reading as a pass, in the
     * suite meant to prove the package works at all.
     *
     * These assertions are the fix. `npm run test:e2e` rebuilds both in order; this
     * refuses to interpret a pass if that did not happen.
     */
    it('dist/ is newer than src/', () => {
        const src = newestMtime(`${repoRoot}/src`);
        const dist = statSync(distEntry).mtimeMs;
        expect(
            dist,
            'dist/index.mjs is older than src/. The tests below would certify a stale ' +
                'build. Run `npm run test:e2e`, which rebuilds in the right order.',
        ).toBeGreaterThan(src);
    });

    it('the example bundle is newer than dist/', () => {
        const dist = statSync(distEntry).mtimeMs;
        const bundle = statSync(exampleEntry).mtimeMs;
        expect(
            bundle,
            'example/build is older than dist/. SvelteKit inlined a previous dist, so ' +
                'these tests measure an artifact that no longer matches src/.',
        ).toBeGreaterThan(dist);
    });

    it('serves the app and the mock API', async () => {
        // Positive evidence, before any assertion that could pass on an empty response.
        expect((await fetch(APP)).ok).toBe(true);
        expect((await fetch(`${API}/__test__/fetch-counts`)).ok).toBe(true);
    });

    it('is actually exercising THIS build of the package', async () => {
        // The freshness checks above compare timestamps; this proves the running server
        // reaches our code at all, by asserting a behaviour only this package produces.
        const html = await (await fetch(`${APP}/it`)).text();
        expect(html).toContain("L'idratazione");
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('SPEC §13.1 — the acceptance test', () => {
    it('serves ITALIAN body copy in the raw bytes for /it', async () => {
        const html = await (await fetch(`${APP}/it`)).text();
        const text = visibleBodyText(html);

        // The measurement that started this project was a byte count on visible SSR body
        // text: 5,031 characters, 100% English, on a page serving Italian.
        expect(text.length).toBeGreaterThan(40);
        expect(text).toContain("L'idratazione inizia con un'acqua migliore.");
        expect(text).toContain('Acquista ora');
        expect(text).toContain('Scelto dai professionisti');

        // And the English must NOT be there. Without this, a page emitting both would
        // pass — and "contains Italian" is exactly the check that would miss it.
        expect(text).not.toContain('Hydration begins with better water.');
        expect(text).not.toContain('Shop now');
    });

    it('translates indexed metadata, which is what motivated the package', async () => {
        const html = await (await fetch(`${APP}/it`)).text();

        expect(html).toContain("<title>L'idratazione inizia con un'acqua migliore.</title>");
        expect(html).toMatch(/<meta name="description" content="Scelto dai professionisti"/);
        expect(html).toMatch(/<meta property="og:title" content="L'idratazione/);
        // Translatable attributes travel too.
        expect(html).toContain('alt="Un bicchiere d\'acqua"');
    });

    it('sets the right lang attribute per locale', async () => {
        for (const [path, lang] of [['', 'en'], ['it', 'it'], ['de', 'de'], ['ru', 'ru']] as const) {
            const html = await (await fetch(`${APP}/${path}`)).text();
            expect(html).toMatch(new RegExp(`<html lang="${lang}"[ >]`));
        }
    });

    it('serves the BASE locale in base language — the negative control', async () => {
        // Without this, a server that returned Italian for everything would pass above.
        const text = visibleBodyText(await (await fetch(APP)).text());
        expect(text).toContain('Hydration begins with better water.');
        expect(text).not.toContain('idratazione');
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('SRV-4 — the client is handed the catalog the server rendered with', () => {
    /**
     * The server half of SRV-4, asserted on the SERVED BYTES. The chain is
     * `hooks.server.ts` (preloadCatalog into locals) -> `+layout.server.ts` (returns it) ->
     * SvelteKit's inline hydration data. It has already broken silently once: locals were
     * assigned AFTER `resolve()`, so the payload serialised `langsysCatalog: undefined`
     * while every page still rendered Italian — the render had its own copy, and nothing
     * asserted the hand-off. The synchronous client seed that consumes this is the browser
     * core's half and the example does not call one yet, so this asserts only what this
     * lane owes: the bytes a client hydrates from carry the catalog the server used.
     */
    const inlineScripts = (html: string): string =>
        [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

    it('serves the Italian catalog in the hydration payload for /it', async () => {
        const data = inlineScripts(await (await fetch(`${APP}/it`)).text());
        expect(data, 'no inline script carried the layout data at all').toContain('langsysCatalog');
        // Body copy is excluded above, so this can only be matched by the handed-off catalog.
        expect(data).toContain("L'idratazione inizia con un'acqua migliore.");
        expect(data).toMatch(/"?langsysLocale"?:\s*"it"/);
    });

    it('NEGATIVE CONTROL: /de is handed its own catalog, not the Italian one', async () => {
        const data = inlineScripts(await (await fetch(`${APP}/de`)).text());
        expect(data).toContain('langsysCatalog');
        expect(data).toMatch(/"?langsysLocale"?:\s*"de"/);
        expect(data).not.toContain("L'idratazione");
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('SRV-6 and GATE-10 on the served response', () => {
    it('a URL locale needs no Vary; a header-negotiated one varies on Accept-Language', async () => {
        const byUrl = await fetch(`${APP}/it`, { headers: { 'accept-language': 'de' } });
        expect(byUrl.headers.get('vary') ?? '').not.toMatch(/accept-language|cookie/i);
        expect(await byUrl.text()).toContain('<html lang="it"');

        const byHeader = await fetch(`${APP}/`, { headers: { 'accept-language': 'it' } });
        expect(byHeader.headers.get('vary') ?? '').toMatch(/accept-language/i);
        expect(await byHeader.text()).toContain('<html lang="it"');
    });

    it('a cookie beats the header and varies on Cookie; an unsupported cookie is skipped', async () => {
        const byCookie = await fetch(`${APP}/`, { headers: { cookie: 'locale=de', 'accept-language': 'it' } });
        expect(byCookie.headers.get('vary') ?? '').toMatch(/cookie/i);
        expect(await byCookie.text()).toContain('<html lang="de"');

        const unsupported = await fetch(`${APP}/`, { headers: { cookie: 'locale=xx', 'accept-language': 'it' } });
        expect(await unsupported.text()).toContain('<html lang="it"');
        expect(unsupported.headers.get('set-cookie')).toBeNull();
    });

    it('a non-base render marks its root resolved; the base render does not', async () => {
        expect(await (await fetch(`${APP}/it`)).text()).toContain('<html lang="it" data-ls-resolved="it">');
        const base = await (await fetch(APP)).text();
        expect(base).toContain('<html lang="en">');
        expect(base).not.toContain('data-ls-resolved');
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('SPEC §13.2 — plurals with more than two forms', () => {
    it('renders the Russian FEW form, which a two-form language cannot express', async () => {
        const text = visibleBodyText(await (await fetch(`${APP}/ru`)).text());
        // 3 -> "бутылки" (few), not "бутылка" (one) and not "бутылок" (many).
        expect(text).toContain('3 бутылки');
        expect(text).not.toContain('3 бутылка');
        expect(text).not.toContain('3 бутылок');
    });

    it('falls back to the base phrase where the catalog has no plural entry', async () => {
        // it/de have no entry for the plural key. Falling back must still INTERPOLATE,
        // or the page renders the literal ICU source.
        const text = visibleBodyText(await (await fetch(`${APP}/it`)).text());
        expect(text).toContain('3 bottles');
        expect(text).not.toContain('{n, plural');
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('SPEC §13.3 — concurrent locales never cross-contaminate', () => {
    it('holds under 120 interleaved requests across four locales', async () => {
        const expected: Record<string, string> = {
            '': 'Hydration begins with better water.',
            it: "L'idratazione inizia con un'acqua migliore.",
            de: 'Hydratation beginnt mit besserem Wasser.',
            ru: 'Гидратация начинается с лучшей воды.',
        };
        const paths = ['', 'it', 'de', 'ru'];

        const results = await Promise.all(
            Array.from({ length: 120 }, async (_, i) => {
                const path = paths[i % paths.length];
                const html = await (await fetch(`${APP}/${path}`)).text();
                return { path, text: visibleBodyText(html) };
            }),
        );

        for (const { path, text } of results) {
            expect(text, `locale "${path || 'en'}" rendered the wrong catalog`).toContain(expected[path]);
            // And it must contain NO other locale's copy.
            for (const [other, phrase] of Object.entries(expected)) {
                if (other !== path) expect(text).not.toContain(phrase);
            }
        }
    }, 60_000);
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('SPEC §13.4 — harvesting without TTFB impact', () => {
    it('registers phrases the catalog could not resolve', async () => {
        await fetch(`${API}/__test__/reset`);
        await fetch(`${APP}/it`);

        // Drain is scheduled after the response flushes, so give it a moment. If it were
        // in the TTFB path this would already have happened before the fetch resolved.
        await new Promise((r) => setTimeout(r, 500));

        const { registered } = (await (await fetch(`${API}/__test__/registered`)).json()) as {
            registered: { phrase: string }[];
        };

        expect(registered.length).toBeGreaterThan(0);
        expect(registered.some((r) => r.phrase.includes('plural'))).toBe(true);
    });

    it('deduplicates within a request', async () => {
        await fetch(`${API}/__test__/reset`);
        await fetch(`${APP}/it`);
        await new Promise((r) => setTimeout(r, 500));

        const { registered } = (await (await fetch(`${API}/__test__/registered`)).json()) as {
            registered: { phrase: string }[];
        };
        const unique = new Set(registered.map((r) => r.phrase));
        expect(registered.length).toBe(unique.size);
    });

    it('does not register anything for the BASE locale', async () => {
        // Every phrase "misses" in the base locale because there is no catalog. Queueing
        // them would register the whole app on every base-locale render.
        await fetch(`${API}/__test__/reset`);
        await fetch(APP);
        await new Promise((r) => setTimeout(r, 500));

        const { registered } = (await (await fetch(`${API}/__test__/registered`)).json()) as {
            registered: unknown[];
        };
        expect(registered).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!built)('caching', () => {
    it('coalesces concurrent cold misses into one upstream fetch', async () => {
        await fetch(`${API}/__test__/reset`);
        await fetch(`${API}/__test__/latency?ms=150`);

        // A locale the app has not served yet in this process, so the memo is cold.
        await Promise.all(Array.from({ length: 20 }, () => fetch(`${APP}/de`)));

        const { fetchCounts } = (await (await fetch(`${API}/__test__/fetch-counts`)).json()) as {
            fetchCounts: Record<string, number>;
        };
        await fetch(`${API}/__test__/latency?ms=0`);

        // Without single-flight this would be up to 20. `de` may already be warm from an
        // earlier test in this file, in which case it is 0 — both are correct, more than
        // one is not.
        expect(fetchCounts.de ?? 0).toBeLessThanOrEqual(1);
    }, 30_000);
});

// ---------------------------------------------------------------------------
describe.skipIf(built)('example not built', () => {
    /**
     * A `skipIf` pair is VACUOUS as a signal, and measuring it says so: with `dist/` and
     * `example/build` removed the suite reported `235 passed | 18 skipped`, exit 0, and
     * the default reporter printed no test names — so the "was NOT verified" message
     * appeared nowhere. It reads fine to a human watching verbose output and is invisible
     * in CI, which is the only place it matters.
     *
     * So this is a real gate, not a message. It FAILS unless the operator has explicitly
     * said an unbuilt run is acceptable.
     */
    it('FAILS, because the acceptance tests could not run', () => {
        if (process.env.LANGSYS_ALLOW_UNBUILT === '1') {
            expect(built).toBe(false);
            return;
        }
        throw new Error(
            'example/build/index.js is absent, so the SPEC §13 acceptance tests did NOT run. ' +
                'This is a failure rather than a skip: "the acceptance tests passed" and "the ' +
                'acceptance tests never executed" must not produce the same exit code.\n' +
                'Run `npm run test:e2e` (rebuilds dist/ and the example in order), or set ' +
                'LANGSYS_ALLOW_UNBUILT=1 to acknowledge an unverified run.',
        );
    });
});
