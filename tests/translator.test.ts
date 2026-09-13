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

describe('CAT-1/CAT-2/CAT-3 — presence decides registration, the value decides display', () => {
    /**
     * These two decisions are made from the same lookup and MUST NOT be made from the
     * same test. Before this block one `hit` boolean drove both: correct for display,
     * wrong for registration.
     *
     * Three states, and only the first may register:
     *   absent               genuine miss
     *   present-with-null    registered, machine translation running
     *   present-non-empty    translated
     *
     * Collapsing the first two re-registers content that registered seconds earlier, for
     * the whole MT window — worst on exactly the projects with the most untranslated
     * copy. CAT-3 is the same defect one level up and costs more: a registered content
     * block comes back as an OBJECT, and a write-enabled session that reads that as a
     * miss re-POSTs the block on every visit.
     *
     * The prototype cases are not paranoia. The fix for the above is an own-property
     * check, and the obvious spelling of it — `phrase in bucket` — reads `toString`,
     * `constructor` and `hasOwnProperty` as KNOWN, silently suppressing their
     * registration. `t('toString')` currently registers for an incidental reason (the
     * inherited value is a function, so the typeof guard rejects it); these tests exist
     * so that stays true on purpose rather than by accident.
     */
    const missesOf = async (catalog: Catalog, phrases: string[], locale = 'it') => {
        const run = serve(catalog, locale);
        const result = await run(() => phrases.map((p) => t(p)));
        return { queued: result.missing.map((m) => m.phrase), rendered: result.value };
    };

    it('does NOT re-register a phrase that is present with a null value', async () => {
        const { queued } = await missesOf({ __uncategorized__: { Pending: null as unknown as string } }, ['Pending']);
        expect(queued).not.toContain('Pending');
    });

    it('does NOT re-register a phrase that is present with an empty string', async () => {
        const { queued } = await missesOf({ __uncategorized__: { Pending: '' } }, ['Pending']);
        expect(queued).not.toContain('Pending');
    });

    it('does NOT re-register a content block present as an object (CAT-3)', async () => {
        const cid = '0ab6be3c04761e7643cb965ae2e9de2e';
        const block = { Hello: null, World: null } as unknown as string;
        const { queued } = await missesOf({ __uncategorized__: { [cid]: block } }, [cid]);
        expect(queued).not.toContain(cid);
    });

    it('POSITIVE CONTROL: a genuinely absent phrase IS registered', async () => {
        // Without this, every assertion above is satisfiable by never registering
        // anything at all.
        const { queued } = await missesOf({ __uncategorized__: { Pending: null as unknown as string } }, ['NotThere']);
        expect(queued).toContain('NotThere');
    });

    it('still registers inherited Object.prototype names — `in` would not', async () => {
        const { queued } = await missesOf({ __uncategorized__: {} }, [
            'toString',
            'constructor',
            'hasOwnProperty',
            'valueOf',
        ]);
        expect(queued).toEqual(
            expect.arrayContaining(['toString', 'constructor', 'hasOwnProperty', 'valueOf']),
        );
    });

    it('an inherited name present as a REAL entry is not re-registered', async () => {
        // The other half of the prototype case: once "toString" is genuinely in the
        // catalog it must behave like any other registered phrase.
        const { queued, rendered } = await missesOf(
            { __uncategorized__: { toString: 'Da stringa' } },
            ['toString'],
        );
        expect(queued).not.toContain('toString');
        expect(rendered).toEqual(['Da stringa']);
    });

    it('CAT-2: the same three states still DISPLAY source text', async () => {
        // Registration stops for these; display must not. An implementer can satisfy
        // CAT-1 and still ship blank <h1>s.
        const cid = 'ff'.repeat(16);
        const { rendered } = await missesOf(
            {
                __uncategorized__: {
                    NullValue: null as unknown as string,
                    EmptyValue: '',
                    [cid]: { inner: null } as unknown as string,
                },
            },
            ['NullValue', 'EmptyValue', cid],
        );
        expect(rendered).toEqual(['NullValue', 'EmptyValue', cid]);
    });

    it('a miss in the BASE locale is still never registered', async () => {
        // Pre-existing behaviour the presence check must not disturb.
        const { queued } = await missesOf({ __uncategorized__: {} }, ['Anything'], 'en');
        expect(queued).toEqual([]);
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

describe('TOK-5 — `%name%` is accepted as the escape for `{name}`', () => {
    // The interpolator is the core's, imported from /pure. This pins that both forms reach
    // an author through THIS package's t(), which is where a framework forced the escape.
    const server = () =>
        createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale: 'en',
            fetch: (async () =>
                new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })) as unknown as typeof globalThis.fetch,
        });

    it('resolves {name} and %name% to the same output', async () => {
        const out = await server().run({ locale: 'en' }, () => [
            t('Hello {name}', { name: 'Ada' }),
            t('Hello %name%', { name: 'Ada' }),
        ]);
        expect(out.value).toEqual(['Hello Ada', 'Hello Ada']);
    });

    it('CONTROL: percent signs with no matching key are left alone', async () => {
        const out = await server().run({ locale: 'en' }, () => t('Save 20%off% today', { name: 'Ada' }));
        expect(out.value).toBe('Save 20%off% today');
    });
});

describe('ICU-1/2/3/5 — recovery through THIS package\'s t(), on every path', () => {
    /**
     * `interpolate` is the core's, and importing it proves the function, not the call path
     * into it (CONF-1's every-path clause). The path is where the sibling server cores broke:
     * Ruby's `Client#interpolate` returned early on empty params, so `t('Welcome')` rendered
     * raw ICU source, and PHP measured that re-adding the same short-circuit left its suite
     * green. Expectations come from the spec's rule text and the cross-SDK fixture rows, not
     * from calling `interpolate` here.
     */
    const SELECT = '{g, select, male {He} female {She} other {They}} left';
    const PLURAL = '{count, plural, one {# item} other {# items}}';
    const server = (baseLocale: string, catalog: Record<string, unknown> = {}) =>
        createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale,
            harvest: false,
            fetch: (async (url: string | URL) =>
                new Response(
                    JSON.stringify(
                        String(url).includes('authorize-project')
                            ? { status: true, data: { key_type: 'read' } }
                            : { status: true, data: catalog },
                    ),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )) as unknown as typeof globalThis.fetch,
        });
    const inScope = async <T>(fn: () => T, baseLocale = 'en', locale = baseLocale, catalog?: Record<string, unknown>) =>
        (await server(baseLocale, catalog).run({ locale }, fn)).value;

    it('ICU-1: an EMPTY params map renders its other branch', async () => {
        expect(await inScope(() => t(SELECT, {}))).toBe('They left');
    });

    it('ICU-2: a null argument is absent on the t() path, not the string "null"', async () => {
        expect(await inScope(() => t(SELECT, { g: null } as never))).toBe('They left');
    });

    it('ICU-5: a supplied plural keeps CLDR selection beside a missing select (ru, n=3 is few)', async () => {
        // Distinct words per branch, so a simplified renderer that picks `other` for 3 fails
        // rather than landing on the same text.
        const phrase = '{g, select, other {X}} {n, plural, one {# one} few {# few} many {# many} other {# other}}';
        expect(await inScope(() => t(phrase, { n: 3 }), 'ru')).toBe('X 3 few');
    });

    it('CONTROL: plain text with no params comes back unchanged', async () => {
        expect(await inScope(() => t('Hello there'))).toBe('Hello there');
    });

    it('CONTROL: plain text carrying braces or apostrophes, with no params, is left exactly as written', async () => {
        // The risk in fixing ICU-1 by always interpolating: prose that merely LOOKS like
        // syntax — an unbalanced brace, an apostrophe, a doubled brace, a placeholder with no
        // param — must not be reformatted or throw into the render path.
        const prose = ["Don't stop", "It's 5 o'clock", 'Price: {', '50% {off', 'a } b', 'Use {{double}} braces', "'{literal}'", 'Hello {name}'];
        expect(await inScope(() => prose.map((p) => t(p)))).toEqual(prose);
    });

    // Held core-first until `langsys-js-typescript` `ff57476` shipped the client half, then
    // flipped together: with no params at all, t() renders ICU on every path.
    it('ICU-1: a select with NO params at all renders its other branch, not the ICU source', async () => {
        expect(await inScope(() => t(SELECT))).toBe('They left');
    });

    it('ICU-1: the category overload with no params takes the same path', async () => {
        expect(await inScope(() => t(SELECT, 'cat'))).toBe('They left');
    });

    it('ICU-1 + ICU-3: a plural with no params keeps the sentence and shows {count}, not a number', async () => {
        expect(await inScope(() => t(PLURAL))).toBe('{count} items');
    });

    it('ICU-1 on a catalog HIT, not only on the fallback phrase', async () => {
        const catalog = { __uncategorized__: { [SELECT]: '{g, select, male {Lui} female {Lei} other {Loro}} è uscito' } };
        expect(await inScope(() => t(SELECT), 'en', 'it', catalog)).toBe('Loro è uscito');
    });

    it('ICU-1 outside a request scope, where t() takes a separate return', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(t(SELECT)).toBe('They left');
    });
});
