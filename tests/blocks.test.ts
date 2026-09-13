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


describe('substitution places each translation where the tokenizer took its token', () => {
    /**
     * Found by the TS lane's attribute probe, which asked whether register and lookup keys
     * agree. Keys did agree. The defect was worse: substitution re-walked the fragment and
     * consumed translations BY POSITION, but walked a different order than the tokenizer.
     * The tokenizer skips translation-excluded and phrase-marked subtrees and emits
     * attribute and value tokens before an element's text; the old substitute() mirrored
     * only the code-element skip. So a block containing an image shifted every later text
     * node onto the translation meant for the token before it, a phrase-marked span was
     * overwritten, and attribute translations never rendered.
     *
     * Every fixture here translates each token to `[token]`, so the rendered HTML shows
     * exactly which token's translation landed where. The requirement is behavioural, as
     * the reviewer put it: each translation lands at the exact location its token came
     * from, on every branch. Each test pins one branch and goes red when it reverts.
     */
    async function bracketRender(html: string, block?: Record<string, string>): Promise<string> {
        const tokens = tokenizeHtml(html);
        const entries = block ?? Object.fromEntries(tokens.map((t) => [t, '[' + t + ']']));
        const { run } = serve({ __uncategorized__: { [blockId(html, '')]: entries as never } });
        return (await run(() => renderTranslateBlock(html))).value.html;
    }

    it('CONTROL: text-only markup renders every token in place', async () => {
        expect(await bracketRender('<p>One <b>Two</b> Three</p>')).toBe('<p>[One] <b>[Two]</b> [Three]</p>');
    });

    it('an attribute is translated in place, and the text after it gets its OWN translation', async () => {
        expect(await bracketRender('<p><img alt="Hi there"> Body text</p>')).toBe(
            '<p><img alt="[Hi there]"> [Body text]</p>',
        );
    });

    it('an attribute after some text shifts nothing', async () => {
        expect(await bracketRender('<p>Lead <img alt="Pic"> Trail</p>')).toBe('<p>[Lead] <img alt="[Pic]"> [Trail]</p>');
    });

    it('several attributes on one element each land on their own attribute', async () => {
        expect(await bracketRender('<p><img alt="A" title="T"> Body</p>')).toBe('<p><img alt="[A]" title="[T]"> [Body]</p>');
    });

    it('TOK-3 order decides the token sequence, but location decides where each lands', async () => {
        // Source order title-then-alt; token order is the constant (alt before title).
        // A positional applier would write alt's translation into title. Each must land on
        // its own attribute whatever order the author wrote them in.
        expect(await bracketRender('<p><img title="T" alt="A"> Body</p>')).toBe('<p><img title="[T]" alt="[A]"> [Body]</p>');
    });

    it('a button value lands on the value attribute, and the button text on the text', async () => {
        expect(await bracketRender('<p>Before <button value="Go">Click</button> after</p>')).toBe(
            '<p>[Before] <button value="[Go]">[Click]</button> [after]</p>',
        );
    });

    it('an input submit value lands on the value attribute', async () => {
        expect(await bracketRender('<p><input type="submit" value="Send"> Tail</p>')).toBe(
            '<p><input type="submit" value="[Send]"> [Tail]</p>',
        );
    });

    it('a phrase-marked subtree is left INTACT, not overwritten', async () => {
        expect(await bracketRender('<p>Intro <span data-ls-phrase>Marked phrase</span> outro</p>')).toBe(
            '<p>[Intro] <span data-ls-phrase="">Marked phrase</span> [outro]</p>',
        );
    });

    it('a translate="no" subtree is left intact', async () => {
        expect(await bracketRender('<p>Intro <span translate="no">Brand</span> outro</p>')).toBe(
            '<p>[Intro] <span translate="no">Brand</span> [outro]</p>',
        );
    });

    it('a data-notrans subtree is left intact', async () => {
        expect(await bracketRender('<p>Intro <span data-notrans>Brand</span> outro</p>')).toBe(
            '<p>[Intro] <span data-notrans="">Brand</span> [outro]</p>',
        );
    });

    it('an excluded element keeps its own attributes untranslated too', async () => {
        // The tokenizer returns before harvesting attributes of an excluded element, so
        // its alt is not a token; the applier must not touch it either.
        expect(await bracketRender('<p><img translate="no" alt="Logo"> Tail</p>')).toBe(
            '<p><img translate="no" alt="Logo"> [Tail]</p>',
        );
    });

    it.each([
        ['a line break', 'Your' + String.fromCodePoint(0x0a) + 'name'],
        ['a doubled space', 'Your  name'],
        ['an NBSP', 'Your' + String.fromCodePoint(0x00a0) + 'name'],
    ])('a placeholder with %s registers and LOOKS UP under the same key', async (_label, value) => {
        // The probe as asked: the registered key and the lookup key must be identical.
        // Both are the normalized token, so one catalog entry under "Your name" must apply.
        const html = '<input placeholder="' + value + '">';
        expect(tokenizeHtml(html)).toEqual(['Your name']);
        expect(await bracketRender(html, { 'Your name': 'Il tuo nome' })).toBe('<input placeholder="Il tuo nome">');
    });

    it('option duplicates: the shared walk yields one location per token, and text renders once', async () => {
        // duplicateSelectOptions exists only to reproduce pre-0.6.3 token arity for reading
        // old ids; render never enables it. Pinned anyway, because the contract is that
        // every tokenize option yields a location for every token it emits.
        const mod = (await import('../src/tokenizer.js')) as Record<string, unknown>;
        expect(typeof mod.collectSlots, 'collectSlots must exist: the walk shared by tokenizer and applier').toBe(
            'function',
        );
        const collectSlots = mod.collectSlots as (
            h: string,
            o?: object,
        ) => { fragment: never; slots: { token: string; apply(t: string): void }[] };
        const { serialize } = await import('parse5');
        const html = '<select><option>One</option><option>Two</option></select>';
        const legacy = { duplicateSelectOptions: true };
        const { fragment, slots } = collectSlots(html, legacy);
        // A LITERAL, measured by executing the pre-fix tokenizer (HEAD) on this input. Comparing
        // against tokenizeHtml cannot fail any more: tokenizeHtml is now read off these slots,
        // so dropping the duplicate slots moved both sides together and this stayed green.
        expect(slots.map((sl) => sl.token)).toEqual(['One', 'Two', 'One', 'Two']);
        for (const sl of slots) sl.apply('[' + sl.token + ']');
        expect(serialize(fragment)).toBe('<select><option>[One]</option><option>[Two]</option></select>');
    });
});

describe('TOK-1 on the render path — excluded content is left exactly as written', () => {
    // The tokenize half of these lives in tests/conformance/walker-parity.test.ts. These pin
    // the other half: an element the walk skips yields no slot, so nothing is written into
    // it, and foreign content the walk DOES enter is translated in place without disturbing
    // the markup around it.
    async function bracketRender(html: string): Promise<string> {
        const entries = Object.fromEntries(tokenizeHtml(html).map((t) => [t, '[' + t + ']']));
        const { run } = serve({ __uncategorized__: { [blockId(html, '')]: entries as never } });
        return (await run(() => renderTranslateBlock(html))).value.html;
    }

    it('math content is not translated, and the text around it is', async () => {
        expect(await bracketRender('<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>')).toBe(
            '<p>[Area] <math><mi>x</mi><mo>+</mo><mn>2</mn></math> [units]</p>',
        );
    });

    it('inline svg keeps the parent text, translates svg <text> in place, and leaves <path> intact', async () => {
        expect(await bracketRender('<p>Area <svg><path d="M0 0"></path><text>label</text></svg> units</p>')).toBe(
            '<p>[Area] <svg><path d="M0 0"></path><text>[label]</text></svg> [units]</p>',
        );
    });
});

describe('.missing is a record of phrases, not of token positions', () => {
    it('lists a phrase repeated inside one block ONCE, matching what registration sends', async () => {
        // Tokens keep every repeat, because arity is identity and the id must not move. The
        // returned record is a different thing: the phrases this block could not resolve.
        // Registration already posts `Repeat` once; `.missing` listed it four times.
        const html = '<p>Repeat</p><div><p>Repeat</p><div><p>Repeat <b>Repeat</b></p></div></div>';
        expect(tokenizeHtml(html), 'arity is identity: all four stay in the token array').toHaveLength(4);
        const { run, registered } = serve({});
        const result = await run(() => renderTranslateBlock(html));
        expect(result.value.missing).toEqual([{ phrase: 'Repeat', category: '' }]);
        await new Promise((r) => setTimeout(r, 20));
        expect(registered.flat().map((i) => i.phrase)).toEqual(['Repeat']);
    });

    it('CONTROL: distinct phrases are all listed, in document order', async () => {
        const { run } = serve({});
        const result = await run(() => renderTranslateBlock('<p>One</p><p>Two</p><p>One</p><p>Three</p>'));
        expect(result.value.missing.map((m) => m.phrase)).toEqual(['One', 'Two', 'Three']);
    });
});

describe('TOK-3 — the spec vector, proven on both paths', () => {
    // Three listed attributes and two unlisted ones, authored OUT of list order, so a
    // tokenizer that walks the element's own attributes gets the right set in the wrong
    // order and fails here. The spec's own test, and CONF-1's every-path clause.
    const html = '<input data-foo="x" title="T" name="n" placeholder="P" aria-label="L">';

    it('tokenize: three phrases in list order, and nothing from the unlisted two', () => {
        expect(tokenizeHtml(html)).toEqual(['P', 'T', 'L']);
    });

    it('render: each listed attribute translated in place, the unlisted two untouched', async () => {
        const { run } = serve({ __uncategorized__: { [blockId(html, '')]: { P: '[P]', T: '[T]', L: '[L]' } as never } });
        expect((await run(() => renderTranslateBlock(html))).value.html).toBe(
            '<input data-foo="x" title="[T]" name="n" placeholder="[P]" aria-label="[L]">',
        );
    });
});
