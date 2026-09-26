import { describe, expect, it } from 'vitest';
import { createLangsysServer } from '../src/index.js';

/**
 * SRV-6: the request locale comes from the URL, then the cookie, then `Accept-Language`, each
 * validated against the locales the project serves (base and targets, from authorization), and
 * the response varies on what the choice depended on. Plus GATE-10's producing half: a server
 * render marks its root resolved only when its locale is not the base locale.
 */
const server = () =>
    createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        harvest: false,
        fetch: (async (url: string | URL) =>
            new Response(
                JSON.stringify(
                    String(url).includes('authorize-project')
                        ? { status: true, data: { key_type: 'read', base_locale: 'en', target_locales: ['it', 'de-DE', 'es-es'], default_locales: { it: 'it', de: 'de-de', es: 'es-es' } } }
                        : { status: true, data: {} },
                ),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )) as unknown as typeof globalThis.fetch,
    });

const req = (path: string, headers: Record<string, string> = {}) => new Request(`https://shop.example${path}`, { headers });

describe('SRV-6 — a locale the framework already resolved is the one served', () => {
    it('es-ES from the framework is served as es-es, whatever URL, cookie and header say, with no Vary', async () => {
        const r = await server().resolveLocale(req('/it/pricing?locale=de', { cookie: 'locale=it', 'accept-language': 'de' }), { resolved: 'es-ES' });
        expect(r).toEqual({ locale: 'es-es', source: 'framework', vary: [] });
    });
    it('underscore form too: es_ES', async () => {
        expect((await server().resolveLocale(req('/'), { resolved: 'es_ES' })).locale).toBe('es-es');
    });
    it('a bare language is the project\'s default locale for it, from authorization', async () => {
        expect((await server().resolveLocale(req('/'), { resolved: 'es' })).locale).toBe('es-es');
        expect((await server().resolveLocale(req('/'), { resolved: 'de' })).locale).toBe('de-de');
    });
    it('an unsupported framework locale is served as the base, still with no Vary', async () => {
        expect(await server().resolveLocale(req('/it', { 'accept-language': 'it' }), { resolved: 'ja-JP' })).toEqual({ locale: 'en', source: 'framework', vary: [] });
    });
});

describe('SRV-6 — one URL, four requests', () => {
    it('a URL locale beats a conflicting cookie and header, and adds no Vary', async () => {
        const r = await server().resolveLocale(req('/it/pricing', { cookie: 'locale=de-de', 'accept-language': 'de' }));
        expect(r).toEqual({ locale: 'it', source: 'url', vary: [] });
    });

    it('a cookie beats a conflicting header, with Vary: Cookie', async () => {
        const r = await server().resolveLocale(req('/pricing', { cookie: 'theme=dark; locale=it', 'accept-language': 'de' }));
        expect(r).toEqual({ locale: 'it', source: 'cookie', vary: ['Cookie'] });
    });

    it('with only a header, the negotiated locale is served with Vary: Accept-Language', async () => {
        const r = await server().resolveLocale(req('/pricing', { 'accept-language': 'fr;q=0.9, de-CH;q=0.8, en;q=0.1' }));
        expect(r.locale).toBe('de-de');
        expect(r.source).toBe('header');
        expect(r.vary).toContain('Accept-Language');
    });

    it('an unsupported cookie is skipped, never served: resolution falls through to the header', async () => {
        const r = await server().resolveLocale(req('/pricing', { cookie: 'locale=xx', 'accept-language': 'it' }));
        expect(r.locale).toBe('it');
        expect(r.source).toBe('header');
    });
});

describe('SRV-6 — validation and fallback', () => {
    it('an unsupported URL segment is not a locale: the next source decides', async () => {
        const r = await server().resolveLocale(req('/pricing/it', { cookie: 'locale=de-de' }));
        expect(r).toEqual({ locale: 'de-de', source: 'cookie', vary: ['Cookie'] });
    });

    it('a query parameter is a URL source too', async () => {
        const r = await server().resolveLocale(req('/pricing?locale=IT', { 'accept-language': 'de' }));
        expect(r).toEqual({ locale: 'it', source: 'url', vary: [] });
    });

    it('nothing usable serves the base locale, varying on what was consulted', async () => {
        const r = await server().resolveLocale(req('/pricing', { 'accept-language': 'fr, ja;q=0.5' }));
        expect(r.locale).toBe('en');
        expect(r.source).toBe('base');
        expect(r.vary).toEqual(['Cookie', 'Accept-Language']);
    });

    it('q=0 is a refusal, not a preference', async () => {
        // The only supported tag is refused, so nothing is acceptable and the base is served.
        const r = await server().resolveLocale(req('/pricing', { 'accept-language': 'it;q=0' }));
        expect(r).toMatchObject({ locale: 'en', source: 'base' });
    });

    it('knobs are wiring: a renamed cookie and a disabled path segment', async () => {
        const r = await server().resolveLocale(req('/it/pricing', { cookie: 'lang=de-de' }), { cookie: 'lang', pathSegment: false });
        expect(r).toEqual({ locale: 'de-de', source: 'cookie', vary: ['Cookie'] });
    });
});

describe('GATE-10 — the producing half', () => {
    it('a non-base render marks its root resolved, in canonical lowercase', () => {
        expect(server().resolvedRootAttributes('de-DE')).toEqual({ 'data-ls-resolved': 'de-de' });
    });

    it('CONTROL: a base-locale render is source and is not marked', () => {
        expect(server().resolvedRootAttributes('en')).toEqual({});
        expect(server().resolvedRootAttributes('EN')).toEqual({});
    });
});
