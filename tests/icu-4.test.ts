import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t, renderTranslateBlock } from '../src/index.js';

/**
 * ICU-4 through this package's `t()`: a recovered (defaulted) argument is noted — only under the
 * server's `debug` option, naming every argument and the locale, once per (template, locale). The
 * core reports the defaulted names through `interpolate`'s `onDefaulted`; this package owns the
 * gating and the per-instance dedupe.
 */
const server = (debug: boolean) =>
    createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        debug,
        harvest: false,
        flushOnExit: false,
        fetch: (async () => new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), { status: 200 })) as unknown as typeof globalThis.fetch,
    });
let log: ReturnType<typeof vi.spyOn>;
const notices = () => log.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).filter((m: string) => m.includes('defaulted'));
beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const TWO = '{g, select, male {He} other {They}} bought {count, plural, one {# item} other {# items}}';

describe('ICU-4 — a defaulted argument is noted under debug', () => {
    it('names every defaulted argument and the locale', async () => {
        await server(true).run({ locale: 'en' }, () => t(TWO, { unrelated: 1 }));
        expect(notices()).toHaveLength(1);
        expect(notices()[0]).toMatch(/"g"/);
        expect(notices()[0]).toMatch(/"count"/);
        expect(notices()[0]).toContain("'en'");
    });
    it('once per (template, locale), however often it renders; a second locale is a second notice', async () => {
        const s = server(true);
        await s.run({ locale: 'en' }, () => {
            t(TWO, { unrelated: 1 });
            t(TWO, { unrelated: 2 });
        });
        await s.run({ locale: 'en' }, () => t(TWO, { unrelated: 3 }));
        expect(notices()).toHaveLength(1);
        await s.run({ locale: 'de' }, () => t(TWO, { unrelated: 4 }));
        expect(notices()).toHaveLength(2);
    });
    it('also on the block path', async () => {
        await server(true).run({ locale: 'en' }, () => renderTranslateBlock('<p>{n, plural, one {# item} other {# items}}</p>'));
        expect(notices().some((m: string) => m.includes('"n"'))).toBe(true);
    });
    it('CONTROL: with debug off, nothing is noted', async () => {
        await server(false).run({ locale: 'en' }, () => t(TWO, { unrelated: 1 }));
        expect(notices()).toEqual([]);
    });
    it('CONTROL: every argument supplied, nothing is noted', async () => {
        await server(true).run({ locale: 'en' }, () => t(TWO, { g: 'male', count: 2 }));
        expect(notices()).toEqual([]);
    });
    it('is per server object: another instance notes the same phrase again', async () => {
        await server(true).run({ locale: 'en' }, () => t(TWO, { unrelated: 1 }));
        await server(true).run({ locale: 'en' }, () => t(TWO, { unrelated: 1 }));
        expect(notices()).toHaveLength(2);
    });
});
