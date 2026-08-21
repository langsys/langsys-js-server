/**
 * `t()` resolution.
 *
 * The two traps encoded here are both [VERIFIED] against the base SDK and both render
 * perfectly in the base language while being wrong everywhere else — which is why they
 * are tested rather than trusted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t, auditRenderedHtml } from '../src/index.js';
import { __resetWarnOnce } from '../src/logger.js';
import type { Catalog } from '../src/types.js';

function serve(catalog: Catalog, locale = 'it') {
    const fetchImpl = (async (url: string | URL) =>
        String(url).includes('authorize-project')
            ? new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), { status: 200 })
            : new Response(JSON.stringify({ status: true, data: catalog }), { status: 200 })) as unknown as typeof globalThis.fetch;

    const langsys = createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', fetch: fetchImpl });
    return <T>(fn: () => T) => langsys.run({ locale }, fn);
}

afterEach(() => {
    __resetWarnOnce();
    vi.restoreAllMocks();
});

describe('resolution', () => {
    it('returns the translation when the catalog has one', async () => {
        const run = serve({ __uncategorized__: { Hello: 'Ciao' } });
        expect((await run(() => t('Hello'))).value).toBe('Ciao');
    });

    it('falls back to the phrase when the catalog does not', async () => {
        const run = serve({ __uncategorized__: {} });
        expect((await run(() => t('Unknown'))).value).toBe('Unknown');
    });

    it('resolves within a category', async () => {
        const run = serve({ marketing: { Hello: 'Ciao di marketing' }, __uncategorized__: { Hello: 'Ciao' } });
        expect((await run(() => t('Hello', 'marketing'))).value).toBe('Ciao di marketing');
        expect((await run(() => t('Hello'))).value).toBe('Ciao');
    });

    it('falls back for an EMPTY-STRING translation rather than rendering blank', async () => {
        // The SDK checks `value.length > 0`. An empty translation is an unfinished one,
        // and rendering it would blank the copy rather than show the source text.
        const run = serve({ __uncategorized__: { Hello: '' } });
        expect((await run(() => t('Hello'))).value).toBe('Hello');
    });

    it('falls back when the entry is an OBJECT, not a string', async () => {
        // A content block resolves to an object. `value || phrase` does NOT guard this —
        // it returns the object, which stringifies to "[object Object]" in the HTML. The
        // check must be `typeof value === 'string' && value.length > 0`.
        const run = serve({
            __uncategorized__: { Hello: { some: 'content-block shape' } as unknown as string },
        });
        const result = (await run(() => t('Hello'))).value;
        expect(result).toBe('Hello');
        expect(result).not.toContain('object Object');
    });
});

describe('interpolation', () => {
    it('substitutes params, rather than rendering the literal placeholder', async () => {
        // Omitting interpolation renders `Ciao {name}` server-side and `Ciao Bob`
        // client-side — a hydration mismatch on precisely the strings carrying data.
        const run = serve({ __uncategorized__: { 'Hello {name}': 'Ciao {name}' } });
        expect((await run(() => t('Hello {name}', { name: 'Bob' }))).value).toBe('Ciao Bob');
    });

    it('interpolates the FALLBACK phrase too, not just a hit', async () => {
        const run = serve({ __uncategorized__: {} });
        expect((await run(() => t('Hello {name}', { name: 'Bob' }))).value).toBe('Hello Bob');
    });

    it('accepts params as the second argument with no category', async () => {
        const run = serve({ __uncategorized__: { 'Hi {n}': 'Ciao {n}' } });
        expect((await run(() => t('Hi {n}', { n: 3 }))).value).toBe('Ciao 3');
    });

    it('accepts category AND params', async () => {
        const run = serve({ ads: { 'Hi {n}': 'Salve {n}' } });
        expect((await run(() => t('Hi {n}', 'ads', { n: 7 }))).value).toBe('Salve 7');
    });

    it('renders ICU plurals for a language with more than two forms', async () => {
        // Russian has four plural categories. This is the case that makes <Phrase>
        // keep-whole necessary, and it must work through t() as well.
        const ru = '{n, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}';
        const fetchImpl = (async (url: string | URL) =>
            String(url).includes('authorize-project')
                ? new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), { status: 200 })
                : new Response(JSON.stringify({ status: true, data: { __uncategorized__: { items: ru } } }), { status: 200 })) as unknown as typeof globalThis.fetch;

        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', fetch: fetchImpl });

        const one = await langsys.run({ locale: 'ru' }, () => t('items', { n: 1 }));
        const few = await langsys.run({ locale: 'ru' }, () => t('items', { n: 3 }));
        const many = await langsys.run({ locale: 'ru' }, () => t('items', { n: 8 }));

        expect(one.value).toBe('1 элемент');
        expect(few.value).toBe('3 элемента');
        expect(many.value).toBe('8 элементов');
        // The forms must actually differ, or the plural machinery is not engaged.
        expect(new Set([one.value, few.value, many.value]).size).toBe(3);
    });

    it('warns when a param has no placeholder to land in', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const run = serve({ __uncategorized__: { Hello: 'Ciao' } });
        await run(() => t('Hello', { name: 'Bob' }));

        const messages = warn.mock.calls.map((c) => c.join(' '));
        expect(messages.some((m) => m.includes('no matching placeholder'))).toBe(true);
    });
});

describe('called outside a request scope', () => {
    it('returns the base phrase rather than throwing', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(t('Hello')).toBe('Hello');
    });

    it('still interpolates, so the output is not a broken literal', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(t('Hello {name}', { name: 'Bob' })).toBe('Hello Bob');
    });

    it('warns LOUDLY, because base language is invisible in view-source', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        t('Hello');
        const messages = warn.mock.calls.map((c) => c.join(' '));
        expect(messages.some((m) => m.includes('outside a request scope'))).toBe(true);
    });
});

describe('partial-coverage audit', () => {
    it('flags <Phrase> markup that this version does not translate server-side', () => {
        const result = auditRenderedHtml('<div><span data-ls-phrase>Based on <b>5</b> reviews</span></div>');
        expect(result.clean).toBe(false);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].kind).toBe('phrase');
        expect(result.findings[0].excerpt).toBe('Based on 5 reviews');
    });

    it('recognises the PHP marker spelling too', () => {
        expect(auditRenderedHtml('<span data-langsys-phrase>x</span>').clean).toBe(false);
    });

    it('reports clean HTML as clean — the negative control', () => {
        expect(auditRenderedHtml('<div><p>Tutto tradotto</p></div>').clean).toBe(true);
    });

    it('warns through the supplied logger', () => {
        const warn = vi.fn();
        auditRenderedHtml('<span data-ls-phrase>x</span>', {
            log() {},
            warn,
            error() {},
            warnOnce() {},
        });
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0])).toContain('BASE language');
    });

    it('reports one finding for an element carrying BOTH marker spellings', () => {
        // Without the `break`, one problem is reported twice.
        const result = auditRenderedHtml('<span data-ls-phrase data-langsys-phrase>x</span>');
        expect(result.findings).toHaveLength(1);
    });

    it('finds nested markers, not just top-level ones', () => {
        const result = auditRenderedHtml('<div><section><span data-ls-phrase>deep</span></section></div>');
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].excerpt).toBe('deep');
    });
});

describe('partial-coverage audit: content blocks', () => {
    it('finds NOTHING by default, because <Translate> stamps no marker', () => {
        // Verified against the published dist: `data-ls-contentblock` and
        // `data-langsys-contentblock` occur ZERO times, and the only setAttribute calls
        // in the whole SDK are `src` on <img> and translated-attribute write-back. An
        // earlier version of this file queried those invented names — the same defect
        // that shipped briefly in the client-DOM probe.
        const result = auditRenderedHtml('<div data-ls-contentblock>Untranslated block</div>');
        expect(result.clean).toBe(true);
        expect(result.findings).toEqual([]);
    });

    it('finds content blocks when the caller names the attribute', () => {
        const result = auditRenderedHtml(
            '<div data-block>Untranslated block</div>',
            undefined,
            { contentBlockAttributes: ['data-block'] },
        );
        expect(result.clean).toBe(false);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].kind).toBe('content-block');
        expect(result.findings[0].marker).toBe('data-block');
        expect(result.findings[0].excerpt).toBe('Untranslated block');
    });

    it('distinguishes a phrase from a content block in the same document', () => {
        const result = auditRenderedHtml(
            '<div><span data-ls-phrase>A phrase</span><div data-block>A block</div></div>',
            undefined,
            { contentBlockAttributes: ['data-block'] },
        );
        expect(result.findings.map((f) => f.kind).sort()).toEqual(['content-block', 'phrase']);
    });

    it('does not flag an unnamed attribute — the negative control', () => {
        const result = auditRenderedHtml('<div data-something-else>x</div>', undefined, {
            contentBlockAttributes: ['data-block'],
        });
        expect(result.clean).toBe(true);
    });
});
