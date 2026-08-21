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
import { generateCustomId as ourGenerateCustomId } from '../../src/vendor/pure.js';
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

describe('known divergences are asserted, not skipped', () => {
    for (const c of KNOWN_DIVERGENCES) {
        it(`${c.name} — ${c.proves}`, () => {
            const ours = tokenizeHtml(c.html);
            const theirs = domTokens(c.html);

            // If this fails, the base SDK has adopted the skip list and these cases
            // should be MOVED to CORPUS and deleted from here.
            expect(ours).not.toEqual(theirs);

            // And be specific about HOW they differ, so the test can't pass for an
            // unrelated reason — e.g. our tokenizer returning [] for everything.
            expect(ours).toEqual(['Keep']);
            expect(theirs.length).toBeGreaterThan(ours.length);
            expect(theirs[0]).toBe('Keep');
        });
    }

    it('opting out of the skip reproduces the siblings exactly', () => {
        // The fallback read path in derivations.ts depends on this being able to
        // reproduce the un-skipped output byte for byte.
        for (const c of KNOWN_DIVERGENCES) {
            expect(tokenizeHtml(c.html, { skipCodeElements: false })).toEqual(domTokens(c.html));
        }
    });
});
