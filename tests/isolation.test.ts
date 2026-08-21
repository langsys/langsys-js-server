/**
 * Cross-request isolation under concurrency.
 *
 * This is the package's reason to exist, so it is tested by reproducing the race rather
 * than by asserting that the design looks right.
 *
 * The race requires an `await` between the write and the read — which every async `load`
 * function provides — so a test that renders synchronously proves nothing. Every case
 * here yields to the event loop mid-render, and several interleave deliberately at the
 * exact point a module-global implementation would be overwritten.
 */

import { describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t } from '../src/index.js';
import type { Catalog } from '../src/types.js';

const CATALOGS: Record<string, Catalog> = {
    it: { __uncategorized__: { Hello: 'Ciao', Goodbye: 'Arrivederci' } },
    de: { __uncategorized__: { Hello: 'Hallo', Goodbye: 'Auf Wiedersehen' } },
    fr: { __uncategorized__: { Hello: 'Bonjour', Goodbye: 'Au revoir' } },
    es: { __uncategorized__: { Hello: 'Hola', Goodbye: 'Adiós' } },
};

/** A fetch stub with a settable delay, so slow and fast locales can be interleaved. */
function makeFetch(delays: Record<string, number> = {}) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
        const href = String(url);
        calls.push(href);

        if (href.includes('authorize-project')) {
            return new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        const locale = new URL(href).searchParams.get('locale') ?? 'en';
        const delay = delays[locale] ?? 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));

        return new Response(JSON.stringify({ status: true, data: CATALOGS[locale] ?? {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;

    return { fetchImpl, calls };
}

function server(delays?: Record<string, number>) {
    const { fetchImpl, calls } = makeFetch(delays);
    return {
        langsys: createLangsysServer({
            projectId: 'p1',
            apiKey: 'k1',
            baseLocale: 'en',
            fetch: fetchImpl,
        }),
        calls,
    };
}

describe('the harness itself', () => {
    it('resolves different catalogs per locale, or nothing below means anything', async () => {
        const { langsys } = server();
        const it_ = await langsys.run({ locale: 'it' }, () => t('Hello'));
        const de = await langsys.run({ locale: 'de' }, () => t('Hello'));
        expect(it_.value).toBe('Ciao');
        expect(de.value).toBe('Hallo');
    });
});

describe('concurrent requests for different locales', () => {
    it('do not cross-contaminate when renders interleave across awaits', async () => {
        const { langsys } = server({ it: 40, de: 5, fr: 20, es: 1 });

        // Each render yields several times, so the scheduler interleaves them. A
        // module-global catalog would be overwritten by whichever fetch resolved last.
        const render = (locale: string) =>
            langsys.run({ locale }, async () => {
                const first = t('Hello');
                await new Promise((r) => setTimeout(r, 10));
                const second = t('Goodbye');
                await new Promise((r) => setTimeout(r, 5));
                const third = t('Hello');
                return [first, second, third];
            });

        const [it_, de, fr, es] = await Promise.all([
            render('it'),
            render('de'),
            render('fr'),
            render('es'),
        ]);

        expect(it_.value).toEqual(['Ciao', 'Arrivederci', 'Ciao']);
        expect(de.value).toEqual(['Hallo', 'Auf Wiedersehen', 'Hallo']);
        expect(fr.value).toEqual(['Bonjour', 'Au revoir', 'Bonjour']);
        expect(es.value).toEqual(['Hola', 'Adiós', 'Hola']);
    });

    it('holds under many interleaved requests, repeated', async () => {
        const { langsys } = server({ it: 3, de: 1, fr: 2, es: 4 });
        const locales = ['it', 'de', 'fr', 'es'] as const;

        const results = await Promise.all(
            Array.from({ length: 200 }, (_, i) => {
                const locale = locales[i % locales.length];
                return langsys.run({ locale }, async () => {
                    await new Promise((r) => setTimeout(r, i % 7));
                    const a = t('Hello');
                    await new Promise((r) => setTimeout(r, (i * 3) % 5));
                    const b = t('Goodbye');
                    return { locale, a, b };
                });
            }),
        );

        for (const { value } of results) {
            expect(value.a).toBe(CATALOGS[value.locale].__uncategorized__.Hello);
            expect(value.b).toBe(CATALOGS[value.locale].__uncategorized__.Goodbye);
        }
    });

    it('keeps miss queues per-request rather than pooled', async () => {
        const { langsys } = server();

        // Explicit barriers rather than sleeps. Timing-based interleaving is not
        // reliable enough to be a regression test: this exact case passed against a
        // deliberately module-global implementation because the sleeps happened not to
        // line up. Forcing the order makes the test prove what it claims.
        let germanHasEntered!: () => void;
        const germanEntered = new Promise<void>((r) => (germanHasEntered = r));

        const [it_, de] = await Promise.all([
            langsys.run({ locale: 'it' }, async () => {
                t('OnlyInItalianRender');
                // Hand control to the German render, which installs its own scope.
                await germanEntered;
                // Resume INSIDE the Italian scope, after German's scope was the most
                // recent one installed. A module-global implementation queues this onto
                // German's queue, and Italian's phrase is registered under the wrong
                // request.
                t('AlsoOnlyItalian');
            }),
            langsys.run({ locale: 'de' }, async () => {
                t('OnlyInGermanRender');
                germanHasEntered();
            }),
        ]);

        expect(it_.missing.map((m) => m.phrase).sort()).toEqual([
            'AlsoOnlyItalian',
            'OnlyInItalianRender',
        ]);
        expect(de.missing.map((m) => m.phrase)).toEqual(['OnlyInGermanRender']);
    });

    it('nested scopes do not leak outward', async () => {
        const { langsys } = server();

        const outer = await langsys.run({ locale: 'it' }, async () => {
            const before = t('Hello');
            const inner = await langsys.run({ locale: 'de' }, async () => {
                await new Promise((r) => setTimeout(r, 5));
                return t('Hello');
            });
            await new Promise((r) => setTimeout(r, 5));
            const after = t('Hello');
            return { before, inner: inner.value, after };
        });

        expect(outer.value).toEqual({ before: 'Ciao', inner: 'Hallo', after: 'Ciao' });
    });
});

describe('catalog fetching', () => {
    it('coalesces concurrent misses for the same locale into ONE fetch', async () => {
        const { langsys, calls } = server({ it: 20 });

        await Promise.all(Array.from({ length: 25 }, () => langsys.run({ locale: 'it' }, () => t('Hello'))));

        const translationCalls = calls.filter((c) => c.includes('/translations'));
        expect(translationCalls).toHaveLength(1);
    });

    it('does not fetch a catalog for the base locale', async () => {
        const { langsys, calls } = server();
        const res = await langsys.run({ locale: 'en' }, () => t('Hello'));

        expect(res.value).toBe('Hello');
        expect(calls.filter((c) => c.includes('/translations'))).toHaveLength(0);
    });

    it('does not queue misses in the base locale', async () => {
        // Every phrase "misses" in the base locale because there is no catalog. Queueing
        // them would register the entire app on every base-locale render.
        const { langsys } = server();
        const res = await langsys.run({ locale: 'en' }, () => {
            t('Hello');
            t('Goodbye');
        });
        expect(res.missing).toEqual([]);
    });

    it('renders base language, loudly, when the catalog fetch fails', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failing = (async (url: string | URL) =>
            String(url).includes('authorize-project')
                ? new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), { status: 200 })
                : new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch;

        const langsys = createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale: 'en',
            fetch: failing,
        });

        const res = await langsys.run({ locale: 'it' }, () => t('Hello'));

        // Degrades to base language rather than throwing...
        expect(res.value).toBe('Hello');
        // ...but is NOT silent about it. A silent fallback here is the original defect.
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });
});
