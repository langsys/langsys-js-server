/**
 * Differential parity: this package's STRING tokenizer vs the published
 * `langsys-js-typescript` DOM walker.
 *
 * This is the most important test in the package. It answers SPEC.md open question #3
 * ("can a tokenizer produce byte-identical tokens from an HTML string as from a DOM?")
 * by executing both, rather than by reasoning about them.
 *
 * The expectations come from the real published artifact at a pinned version, NOT from
 * a fixture this repo wrote — so it cannot inherit an error from the same memory that
 * wrote the implementation (SPEC.md §10 rule 2).
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { tokenizeElement, legacyTokenizeElement, generateCustomId } from 'langsys-js-typescript';
import { tokenizeHtml } from '../../src/tokenizer.js';
import { generateCustomId as ourGenerateCustomId } from 'langsys-js-typescript/pure';
import { SKIP_ELEMENTS as SKIP_ELEMENTS_FOR_TEST } from '../../src/constants.js';
import { CORPUS, KNOWN_DIVERGENCES } from './corpus.js';

/** Run the published DOM walker over the same inner HTML. */
function domTokens(innerHtml: string): string[] {
    const div = globalThis.document.createElement('div');
    div.innerHTML = innerHtml;
    return tokenizeElement(div as unknown as Element).tokens;
}

function domLegacyTokens(innerHtml: string): string[] {
    const div = globalThis.document.createElement('div');
    div.innerHTML = innerHtml;
    return legacyTokenizeElement(div as unknown as Element);
}

beforeAll(() => {
    // The published walker reads the `Node` global and, on the applyStyles path,
    // `window`/`document`. Install a real DOM so it runs its ACTUAL code path rather
    // than an early return — a walker that bails early produces the same empty output
    // as the phenomenon under test (SPEC.md §10 rule 4).
    const window = new Window();
    Object.assign(globalThis, {
        window,
        document: window.document,
        Node: window.Node,
    });
});

describe('the harness itself', () => {
    it('actually runs the published DOM walker', () => {
        // Positive evidence that the import resolved and the walker executes. Without
        // this, every parity assertion below could be comparing [] to [] forever.
        expect(domTokens('<p>Hello world</p>')).toEqual(['Hello world']);
        expect(domTokens('<p title="A">B</p>')).toEqual(['A', 'B']);
    });

    it('runs against the pinned published version', () => {
        // Read through the filesystem rather than an import: the package's exports
        // field does not expose ./package.json. Pinning matters because a floating
        // version would silently change what "parity" means.
        //
        // On what the pin does and does not buy, because it is easy to over-read:
        // 0.6.5 has the correct NON-COALESCING behaviour (adjacent text nodes are each
        // their own token), and the assertions below depend on it. But the base SDK's
        // IDENTITY CONTRACT comment and its own guarding tests landed on their `main`
        // AFTER 0.6.5 was cut, so the published artifact carries the behaviour and none
        // of the guard. This pin is therefore a bet on a behaviour, not protection
        // against it changing — the protection arrives in their next release. Our own
        // literal-array assertions below are what actually guards it here.
        const pkg = JSON.parse(
            readFileSync(new URL('../../node_modules/langsys-js-typescript/package.json', import.meta.url), 'utf8'),
        );
        expect(pkg.version).toBe('0.6.5');
    });

    it('discriminates — the walker is not returning a constant', () => {
        expect(domTokens('<p>a</p>')).not.toEqual(domTokens('<p>b</p>'));
    });
});

describe('string tokenizer matches the published DOM walker', () => {
    for (const c of CORPUS) {
        it(`${c.name} — ${c.proves}`, () => {
            expect(tokenizeHtml(c.html)).toEqual(domTokens(c.html));
        });
    }
});

/**
 * Parity alone would ALSO pass if both implementations coalesced adjacent text nodes.
 * These assert the literal token arrays, so the cases prove separation rather than
 * agreement-on-the-wrong-answer. SPEC.md §10 rule 4: assert on positive evidence.
 */
describe('adjacent text nodes are NOT coalesced (React isomorphism)', () => {
    it('a comment separates the text either side, in BOTH implementations', () => {
        expect(tokenizeHtml('<span>Hello <!-- -->Bob<!-- -->!</span>')).toEqual(['Hello', 'Bob', '!']);
        expect(domTokens('<span>Hello <!-- -->Bob<!-- -->!</span>')).toEqual(['Hello', 'Bob', '!']);
    });

    it('the control coalesces — one text node is one token', () => {
        expect(tokenizeHtml('<span>Hello Bob!</span>')).toEqual(['Hello Bob!']);
        expect(domTokens('<span>Hello Bob!</span>')).toEqual(['Hello Bob!']);
    });

    it('matches the measured React shape exactly', () => {
        const html = '<span>Hello <!-- -->Bob<!-- -->!<br/><b>bold</b></span>';
        expect(tokenizeHtml(html)).toEqual(['Hello', 'Bob', '!', 'bold']);
        expect(domTokens(html)).toEqual(['Hello', 'Bob', '!', 'bold']);
    });

    it('a zero-length comment still separates', () => {
        expect(tokenizeHtml('<p>a<!---->b</p>')).toEqual(['a', 'b']);
    });

    it('stripping comments as strings would re-key — proof of the cost', () => {
        // What a regex-based "strip comments first" implementation would produce.
        const stripped = '<span>Hello <!-- -->Bob<!-- -->!</span>'.replace(/<!--[\s\S]*?-->/g, '');
        expect(tokenizeHtml(stripped)).toEqual(['Hello Bob!']);
        // ...and it is a DIFFERENT custom_id. This is the re-key, made visible.
        expect(ourGenerateCustomId('', tokenizeHtml(stripped))).not.toBe(
            ourGenerateCustomId('', tokenizeHtml('<span>Hello <!-- -->Bob<!-- -->!</span>')),
        );
    });
});

describe('custom_id agrees, which is what actually fragments catalogs', () => {
    for (const c of CORPUS) {
        it(`${c.name}`, () => {
            const ours = ourGenerateCustomId('marketing', tokenizeHtml(c.html));
            const theirs = generateCustomId('marketing', domTokens(c.html));
            expect(ours).toBe(theirs);
        });
    }

    it('identical content under different categories yields different ids', () => {
        const tokens = tokenizeHtml('<p>Same</p>');
        expect(ourGenerateCustomId('a', tokens)).not.toBe(ourGenerateCustomId('b', tokens));
    });

    it('token ORDER is part of the identity, not just the set', () => {
        expect(ourGenerateCustomId('', ['A', 'B'])).not.toBe(ourGenerateCustomId('', ['B', 'A']));
    });
});

describe('legacy derivation matches legacyTokenizeElement', () => {
    for (const c of CORPUS) {
        it(`${c.name}`, () => {
            expect(tokenizeHtml(c.html, { duplicateSelectOptions: true })).toEqual(domLegacyTokens(c.html));
        });
    }
});

describe('the script/style divergence has ENDED — these now assert agreement', () => {
    /**
     * This block used to assert that we deliberately DIFFERED from the base SDK here,
     * with a comment saying that if it ever failed, the base SDK had adopted the skip
     * list and the cases should move to agreement. That is what happened: the core ships
     * `NON_TRANSLATABLE_ELEMENTS` via `langsys-js-typescript/pure`, and this package now
     * consumes it rather than maintaining its own.
     *
     * The assertions are inverted rather than deleted. What was the only place this
     * package knowingly differed on identity is now the place that proves it no longer
     * does, and that is worth a test either way round.
     */
    for (const c of KNOWN_DIVERGENCES) {
        it(`${c.name} — now agrees with the core`, () => {
            const ours = tokenizeHtml(c.html);
            const theirs = domTokens(c.html);

            expect(ours).toEqual(theirs);
            // Specific, so this cannot pass for an unrelated reason — two tokenizers
            // both returning [] would satisfy the line above.
            expect(ours).toEqual(['Keep']);
        });
    }

    it('skipCodeElements:false now reproduces HISTORY, not the siblings', () => {
        // The option is not dead, but what it means has changed and the change is easy
        // to miss. It existed so `derivations.ts` could read under the siblings'
        // un-skipped shape; the siblings no longer emit that shape, so it now reproduces
        // only what THIS package stored before convergence. Asserting the inequality
        // keeps that distinction from silently rotting back into "reproduces the
        // siblings", which is what the comment here used to say.
        for (const c of KNOWN_DIVERGENCES) {
            const unskipped = tokenizeHtml(c.html, { skipCodeElements: false });
            expect(unskipped).not.toEqual(domTokens(c.html));
            expect(unskipped.length).toBeGreaterThan(domTokens(c.html).length);
        }
    });
});

describe('TOK-1 — noscript is EXCLUDED, and the parser contract is still pinned', () => {
    /**
     * Two separate obligations, deliberately not merged.
     *
     * TOK-1 excludes `<noscript>`, so its body produces NO token at all. That is the rule.
     *
     * `scriptingEnabled: true` is pinned anyway, because it governs how the rest of the
     * tokenizer reads the document and this package's agreement with the browser used to
     * rest on an un-asserted parse5 default. It no longer decides the noscript id — the
     * exclusion does — but a parse5 major flipping the default would still change how
     * other raw-text contexts parse, with nothing to fail.
     *
     * The ids below are MEASURED, in headless Chromium 153.0.8010.12 via Playwright with
     * the core's browser bundle in a live page, before the exclusion landed. They are kept
     * as the record of WHY the exclusion exists: the JS family agreed on one id, the
     * scripting-disabled parsers (libxml2, happy-dom, jsdom) on another, for identical
     * source.
     */
    const NOSCRIPT = '<p>Keep</p><noscript><p>Enable JavaScript</p></noscript>';
    /** What the JS family derived while noscript was still harvested. */
    const JS_FAMILY_ID_BEFORE = '68a99f77615d438ede3cdb21710f7826';
    /** What a scripting-disabled parser derived for the same source. */
    const LIBXML_ID_BEFORE = 'e029887102428df850dbdef551c52eb4';

    it('produces NO token for a noscript body', () => {
        expect(tokenizeHtml(NOSCRIPT)).toEqual(['Keep']);
    });

    it('ORDINARY-MARKUP CONTROL: a tokenizer that tokenizes nothing does not pass', () => {
        // The control TOK-1 names explicitly. A test built only from excluded elements is
        // satisfied by a tokenizer that returns [] for everything, which would "exclude"
        // noscript perfectly and harvest nothing at all.
        expect(tokenizeHtml('<p>Keep</p><p>Ordinary</p>')).toEqual(['Keep', 'Ordinary']);
        expect(tokenizeHtml('<div title="Tip">Body</div>')).toEqual(['Tip', 'Body']);
    });

    it('the id no longer depends on which parser read the noscript', () => {
        // The point of the exclusion, stated as the property it buys: both historical ids
        // are now unreachable, so the parser's scripting flag cannot fragment the catalog.
        const id = ourGenerateCustomId('cat', tokenizeHtml(NOSCRIPT));
        expect(id).not.toBe(JS_FAMILY_ID_BEFORE);
        expect(id).not.toBe(LIBXML_ID_BEFORE);
        expect(id).toBe(ourGenerateCustomId('cat', ['Keep']));
    });

    it('the two parser modes really did disagree — or the exclusion bought nothing', () => {
        // Kept from the pre-exclusion pin. Without it, "the ids now agree" is satisfiable
        // in a world where they always agreed and the whole exercise was unnecessary.
        expect(JS_FAMILY_ID_BEFORE).not.toBe(LIBXML_ID_BEFORE);
        expect(ourGenerateCustomId('cat', ['Keep', '<p>Enable JavaScript</p>'])).toBe(JS_FAMILY_ID_BEFORE);
        expect(ourGenerateCustomId('cat', ['Keep', 'Enable JavaScript'])).toBe(LIBXML_ID_BEFORE);
    });

    it('scriptingEnabled is still pinned for the REST of the document', () => {
        // Independent of noscript: a raw-text context the flag also governs.
        expect(tokenizeHtml('<p>Keep</p><script>var a = 1;</script>')).toEqual(['Keep']);
    });
});


describe('TOK-1 — <math> is required by 8.0.1 and this package does NOT exclude it yet', () => {
    /**
     * **A gap recorded as a gap, with a test that flips when it closes.** Spec 8.0.1 adds
     * `<math>` to TOK-1's exclusion list. `langsys-php` already ships it
     * (`NON_PROSE_ELEMENTS` at `e28972c`, measured by executing `extractPhrases`). The
     * JS core does not, and `SKIP_ELEMENTS` here is a re-export of the core's list — so
     * this package does not either.
     *
     * **Not fixed unilaterally, deliberately.** Overriding the re-export would make this
     * package disagree with its own hydration partner on every block containing a
     * `<math>`: we would derive one id, the client core another, for the same DOM on the
     * same request. That is the noscript ordering exactly, and it went the right way round
     * then — core first, then here. CLAUDE.md rule 3 is the standing form of it.
     *
     * Measured three ways on `<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>`:
     *
     *   spec 8.0.1 requires   ['Area', 'units']
     *   langsys-php gives     ['Area', 'units']      (already conformant)
     *   this package gives    ['Area', 'x', '+', '2', 'units']
     *
     * When the core ships it this test goes red, which is the signal to move — the same
     * shape as the attribute-list pin that fired when the twenty-seven landed.
     */
    const MATH = '<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>';

    it('currently tokenizes math content — and must stop when the core does', () => {
        expect(
            SKIP_ELEMENTS_FOR_TEST.includes('math'),
            'The core now excludes <math>. Delete this test, and the TOK-1 gap row in ' +
                'CONFORMANCE.md, and re-measure the corpus — the exclusion arrives ' +
                'automatically through the re-export.',
        ).toBe(false);
        expect(tokenizeHtml(MATH)).toEqual(['Area', 'x', '+', '2', 'units']);
    });

    it('CONTROL: <svg> text IS tokenized, and that is correct, not the same gap', () => {
        // 8.0.1 keeps svg excluded-from-exclusion: the parent's direct text must survive
        // an inline svg and svg <text> must be harvested. Measured as agreeing with PHP.
        expect(tokenizeHtml('<p>Area <svg><text>label</text></svg> units</p>')).toEqual([
            'Area',
            'label',
            'units',
        ]);
    });
});
