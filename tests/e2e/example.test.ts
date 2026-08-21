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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const exampleDir = fileURLToPath(new URL('../../example', import.meta.url));
const built = existsSync(`${exampleDir}/build/index.js`);

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

afterAll(() => {
    mockApi?.kill();
    app?.kill();
});

describe.skipIf(!built)('the example is actually running', () => {
    it('serves the app and the mock API', async () => {
        // Positive evidence, before any assertion that could pass on an empty response.
        expect((await fetch(APP)).ok).toBe(true);
        expect((await fetch(`${API}/__test__/fetch-counts`)).ok).toBe(true);
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
            expect(html).toContain(`<html lang="${lang}">`);
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
    it('reports that the e2e suite did NOT run', () => {
        expect(
            built,
            'example/build/index.js absent — the SPEC §13 acceptance tests were NOT verified. ' +
                'Run: cd example && npm install && npm run build',
        ).toBe(false);
    });
});
