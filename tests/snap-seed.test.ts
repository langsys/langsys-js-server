import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshot } from 'langsys-js-typescript/pure';
import { createLangsysServer, t, SnapshotError } from '../src/index.js';

/**
 * SNAP-2's seam on a server core, and SRV-6's offline served set. A `snapshot` seeds the catalog:
 * lookups read it with no catalog fetch in front of the render, the live catalog outranks it once
 * fetched, registration is decided only against the live catalog (REG-13), and while
 * authorization is unavailable the snapshot's `base_locale` and `locales` are the served set.
 */
const snapshot = buildSnapshot({
    projectId: 'p',
    // A base distinct from the server's configured `en`, so falling through to the SNAPSHOT's base is
    // observable rather than coinciding with the configured one.
    baseLocale: 'en-us',
    categories: ['__uncategorized__'],
    catalogs: {
        'es-es': { __uncategorized__: { Hello: 'Hola (snapshot)', 'Only in snapshot': 'Sólo en la instantánea' } },
    },
});

type World = { authorize: 'ok' | 'down'; catalogDelayMs: number; offline: boolean };
const make = (world: Partial<World> = {}) => {
    const w: World = { authorize: 'ok', catalogDelayMs: 0, offline: false, ...world };
    const log = { catalogGets: 0, registered: [] as string[] };
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (w.offline) throw new TypeError('fetch failed: offline');
        if (href.includes('authorize-project')) {
            if (w.authorize === 'down') throw new TypeError('fetch failed: authorize down');
            return new Response(JSON.stringify({ status: true, data: { key_type: 'write', write_enabled: true, base_locale: 'en', target_locales: ['es-es', 'fr'] } }), { status: 200 });
        }
        if (href.includes('translatable-items')) {
            log.registered.push(...JSON.parse(String(init?.body)).translatable_items.map((i: { phrase: string }) => i.phrase));
            return new Response(JSON.stringify({ status: true }), { status: 200 });
        }
        log.catalogGets++;
        if (w.catalogDelayMs) await new Promise((r) => setTimeout(r, w.catalogDelayMs));
        return new Response(JSON.stringify({ status: true, write_enabled: true, data: { __uncategorized__: { Hello: 'Hola (live)' } } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const langsys = createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', flushOnExit: false, snapshot, fetch: fetchImpl });
    return { langsys, log, world: w };
};
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('SNAP-2 — a seeded snapshot is the preloaded catalog', () => {
    it('the first render reads the snapshot with no catalog fetch in front of it', async () => {
        const { langsys, log } = make({ catalogDelayMs: 200 });
        const out = await langsys.run({ locale: 'es-es' }, () => t('Hello'));
        expect(out.value).toBe('Hola (snapshot)');
        expect(log.catalogGets, 'a background refresh may start, but the render did not wait for it').toBeLessThanOrEqual(1);
    });

    it('the live catalog outranks the snapshot once fetched', async () => {
        const { langsys } = make();
        await langsys.run({ locale: 'es-es' }, () => t('Hello'));
        await settle();
        expect((await langsys.run({ locale: 'es-es' }, () => t('Hello'))).value).toBe('Hola (live)');
    });

    it('with the network unavailable, a phrase the snapshot lacks renders as source', async () => {
        const { langsys } = make({ offline: true });
        const out = await langsys.run({ locale: 'es-es' }, () => [t('Hello'), t('Not anywhere')]);
        expect(out.value).toEqual(['Hola (snapshot)', 'Not anywhere']);
    });

    it('registration is decided only against the live catalog, never the snapshot', async () => {
        const { langsys, log } = make({ catalogDelayMs: 100 });
        // Snapshot-only render: nothing may register, whatever the snapshot holds or lacks.
        await langsys.run({ locale: 'es-es' }, () => [t('Only in snapshot'), t('Brand new')]);
        await settle(250);
        expect(log.registered).toEqual([]);
        // Against the live catalog, which lacks both, both register.
        await langsys.run({ locale: 'es-es' }, () => [t('Only in snapshot'), t('Brand new')]);
        await settle();
        expect(log.registered.sort()).toEqual(['Brand new', 'Only in snapshot']);
    });

    it('an edited or malformed snapshot is refused at construction, by name', () => {
        const edited = { ...structuredClone(snapshot), base_locale: 'de' };
        expect(() => createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', snapshot: edited })).toThrow(SnapshotError);
        expect(() => createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', snapshot: '{not json' })).toThrow(/not JSON/);
    });

    it('CONTROL: without a snapshot, the first render waits for the fetch and renders live', async () => {
        const langsys = createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale: 'en',
            flushOnExit: false,
            fetch: (async (url: string | URL) =>
                new Response(JSON.stringify(String(url).includes('authorize') ? { status: true, data: { key_type: 'read' } } : { status: true, data: { __uncategorized__: { Hello: 'Hola (live)' } } }), { status: 200 })) as unknown as typeof globalThis.fetch,
        });
        expect((await langsys.run({ locale: 'es-es' }, () => t('Hello'))).value).toBe('Hola (live)');
    });
});

describe('SRV-6 — offline, a loaded snapshot answers for authorization', () => {
    const req = (path: string) => new Request(`https://shop.example${path}`);
    it('a locale the snapshot holds is served from it', async () => {
        const { langsys } = make({ authorize: 'down', offline: true });
        const r = await langsys.resolveLocale(req('/?locale=es-ES'));
        expect(r.locale).toBe('es-es');
        expect((await langsys.run({ locale: r.locale }, () => t('Hello'))).value).toBe('Hola (snapshot)');
    });
    it('a locale the snapshot lacks falls through to the snapshot\'s base_locale', async () => {
        const { langsys } = make({ authorize: 'down', offline: true });
        expect((await langsys.resolveLocale(req('/?locale=fr'))).locale).toBe('en-us');
    });
    it('authorization\'s answer replaces the snapshot\'s set once it arrives', async () => {
        const { langsys, world } = make({ authorize: 'down' });
        expect((await langsys.resolveLocale(req('/?locale=fr'))).locale, 'fr is not in the snapshot').toBe('en-us');
        world.authorize = 'ok';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 61_000);
        expect((await langsys.resolveLocale(req('/?locale=fr'))).locale, 'fr is a target locale').toBe('fr');
        vi.useRealTimers();
    });
});
