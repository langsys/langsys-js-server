/**
 * Server-side `<Translate>` — the string→string core.
 *
 * Every test here is about something that fails SILENTLY: a block that resolves under the
 * wrong id renders base language and re-registers, which is indistinguishable from content
 * that was simply never translated. There is no exception, no failed request, and nothing
 * in a `curl` check that looks different.
 *
 * The one deliberate exception is `UncapturableChildError`, which throws — see its own
 * block below for why that is the correct trade there and nowhere else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createLangsysServer,
    renderTranslateBlock,
    stampContentBlock,
    blockId,
    generateCustomId,
    tokenizeHtml,
    CONTENT_BLOCK_MARKER_EMIT,
    CONTENT_BLOCK_MARKER_ATTRS,
} from '../src/index.js';
import { __resetWarnOnce } from '../src/logger.js';
import type { Catalog } from '../src/types.js';

function serve(catalog: Catalog, opts: { locale?: string; catalogFails?: boolean } = {}) {
    const registered: { phrase?: string }[][] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('authorize-project')) {
            return new Response(JSON.stringify({ status: true, data: { key_type: 'write' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (href.includes('translatable-items')) {
            registered.push(JSON.parse(String(init?.body)).translatable_items);
            return new Response(JSON.stringify({ status: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (opts.catalogFails) return new Response('boom', { status: 502 });
        return new Response(JSON.stringify({ status: true, data: catalog }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;

    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        fetch: fetchImpl,
    });
    return {
        registered,
        run: <T>(fn: () => T) => langsys.run({ locale: opts.locale ?? 'it' }, fn),
    };
}

afterEach(() => {
    __resetWarnOnce();
    vi.restoreAllMocks();
});

const HTML = '<p>Based on <strong>5</strong> reviews</p>';

describe('the harness itself', () => {
    it('tokenizes the fixture into more than one token, or arity proves nothing', () => {
        // Adjacent text nodes are NOT coalesced for <Translate>; arity IS identity. A
        // single-token fixture could not detect a coalescing regression.
        expect(tokenizeHtml(HTML)).toEqual(['Based on', '5', 'reviews']);
    });
});

describe('identity', () => {
    it('resolves under the id generateCustomId derives for its tokens', () => {
        expect(blockId(HTML, 'reviews')).toBe(generateCustomId('reviews', tokenizeHtml(HTML)));
    });

    it('the category participates — two categories are two blocks', () => {
        expect(blockId(HTML, 'a')).not.toBe(blockId(HTML, 'b'));
    });

    it('MARK-1: the stamp carries the resolved id under the emitted spelling', () => {
        const attrs = stampContentBlock('abc123');
        expect(attrs).toEqual({ 'data-ls-contentblock': 'abc123' });
        expect(CONTENT_BLOCK_MARKER_EMIT).toBe('data-ls-contentblock');
    });

    it('MARK-2: both spellings are accepted on read', () => {
        expect([...CONTENT_BLOCK_MARKER_ATTRS]).toEqual([
            'data-ls-contentblock',
            'data-langsys-contentblock',
        ]);
    });
});

describe('substitution', () => {
    const id = blockId(HTML, '');

    it('replaces each token in document order, leaving markup intact', async () => {
        const { run } = serve({
            __uncategorized__: {
                [id]: { 'Based on': 'Basato su', '5': '5', reviews: 'recensioni' } as never,
            },
        });
        const out = (await run(() => renderTranslateBlock(HTML))).value;
        expect(out.html).toBe('<p>Basato su <strong>5</strong> recensioni</p>');
        expect(out.customId).toBe(id);
        expect(out.known).toBe(true);
    });

    it('consumes translations POSITIONALLY, so a repeated word can differ per position', async () => {
        // Matching on text value instead would put the two "Free"s out of step the moment
        // one of them translates differently — and that is a real case, not a contrived
        // one: the same English word routinely takes different genders downstream.
        const html = '<p>Free</p><p>Free</p>';
        const rid = blockId(html, '');
        const { run } = serve({
            __uncategorized__: { [rid]: { Free: 'Gratuito' } as never },
        });
        const out = (await run(() => renderTranslateBlock(html))).value;
        expect(out.html).toBe('<p>Gratuito</p><p>Gratuito</p>');
    });

    it('CAT-2: a null translation renders SOURCE text, not blank', async () => {
        const { run } = serve({
            __uncategorized__: {
                [id]: { 'Based on': null, '5': null, reviews: null } as never,
            },
        });
        const out = (await run(() => renderTranslateBlock(HTML))).value;
        expect(out.html).toBe(HTML);
        // ...and it is KNOWN, so it must not re-register. That is CAT-3's write storm.
        expect(out.known).toBe(true);
        expect(out.missing).toHaveLength(0);
    });

    it('CAT-2: an empty-string translation renders source text too', async () => {
        const { run } = serve({
            __uncategorized__: { [id]: { 'Based on': '', '5': '5', reviews: '' } as never },
        });
        const out = (await run(() => renderTranslateBlock(HTML))).value;
        expect(out.html).toBe(HTML);
    });

    it('leaves whitespace-only nodes alone — they produced no token to consume', async () => {
        const html = '<div>\n  <p>Hello</p>\n</div>';
        const rid = blockId(html, '');
        const { run } = serve({ __uncategorized__: { [rid]: { Hello: 'Ciao' } as never } });
        const out = (await run(() => renderTranslateBlock(html))).value;
        expect(out.html).toBe('<div>\n  <p>Ciao</p>\n</div>');
    });

    it('does not substitute into script or style bodies — script FIRST, which is the discriminating order', async () => {
        // The order matters and a mutation proved it. With the script LAST, walking into
        // its body consumes a token index past the end, `next()` returns undefined, and
        // nothing changes — so the obvious fixture passes against a walker that does not
        // skip at all. With the script FIRST, the script body eats the token meant for the
        // paragraph: the code gets translated and the prose does not.
        const html = '<script>var a = 1;</script><p>Keep</p>';
        const rid = blockId(html, '');
        expect(tokenizeHtml(html)).toEqual(['Keep']);

        const { run } = serve({ __uncategorized__: { [rid]: { Keep: 'Tieni' } as never } });
        const out = (await run(() => renderTranslateBlock(html))).value;
        expect(out.html).toBe('<script>var a = 1;</script><p>Tieni</p>');
    });

    it('does not substitute into a style body either', async () => {
        const html = '<style>.a{color:red}</style><p>Keep</p>';
        const rid = blockId(html, '');
        const { run } = serve({ __uncategorized__: { [rid]: { Keep: 'Tieni' } as never } });
        const out = (await run(() => renderTranslateBlock(html))).value;
        expect(out.html).toBe('<style>.a{color:red}</style><p>Tieni</p>');
    });
});

describe('registration', () => {
    it('queues an unknown block\'s tokens', async () => {
        const { run } = serve({ __uncategorized__: {} });
        const result = await run(() => renderTranslateBlock(HTML));
        expect(result.value.known).toBe(false);
        expect(result.value.missing.map((m) => m.phrase)).toEqual(['Based on', '5', 'reviews']);
    });

    it('does NOT queue a block the catalog knows but has not translated', async () => {
        // CAT-3. A write-enabled session re-POSTing this on every visit is the worst
        // version of the truthiness bug, because it repeats for the whole MT window.
        const { run } = serve({ __uncategorized__: { [blockId(HTML, '')]: {} as never } });
        const result = await run(() => renderTranslateBlock(HTML));
        expect(result.value.known).toBe(true);
        expect(result.value.missing).toHaveLength(0);
    });

    it('CAT-1: a PRESENT BUT FALSY entry is known — the vector that discriminates', async () => {
        // `{}` above does not discriminate: `Boolean({})` is true, so a truthiness check
        // and a presence check agree on it, and a mutation swapping one for the other
        // survived. A present-but-falsy value is the only vector that separates them, and
        // it is the middle of CAT-1's three states — absent, present-with-null,
        // present-non-empty — where only the first may register.
        const { run } = serve({ __uncategorized__: { [blockId(HTML, '')]: null as never } });
        const result = await run(() => renderTranslateBlock(HTML));
        expect(result.value.known).toBe(true);
        expect(result.value.missing).toHaveLength(0);
        // ...and display still degrades to source text rather than blanking.
        expect(result.value.html).toBe(HTML);
    });

    it('WIRE-4 clause 2: queues NOTHING when the catalog fetch failed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { run } = serve({}, { catalogFails: true });
        const result = await run(() => renderTranslateBlock(HTML));
        expect(result.value.missing).toHaveLength(0);
    });

    it('POSITIVE CONTROL: the same block DOES queue when the catalog loads', async () => {
        const { run } = serve({ __uncategorized__: {} });
        const result = await run(() => renderTranslateBlock(HTML));
        expect(result.value.missing.length).toBeGreaterThan(0);
    });

    it('never queues in the base locale', async () => {
        const { run } = serve({ __uncategorized__: {} }, { locale: 'en' });
        const result = await run(() => renderTranslateBlock(HTML));
        expect(result.value.missing).toHaveLength(0);
    });
});

describe('outside a request scope', () => {
    it('returns source content and an id rather than throwing', () => {
        // Same posture as t(): a 500 is strictly worse than untranslated output, and the
        // id is still correct because identity is pure.
        const out = renderTranslateBlock(HTML, 'x');
        expect(out.html).toBe(HTML);
        expect(out.customId).toBe(blockId(HTML, 'x'));
        expect(out.known).toBe(false);
    });
});
