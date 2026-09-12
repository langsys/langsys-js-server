/**
 * `<Phrase>` — the rich-text key, asserted against the core lane's golden values.
 *
 * **The expectations are pasted literals, measured by the TypeScript lane on their
 * PRE-refactor encoder.** That is what makes them evidence: recomputing them from the code
 * under test — or from the new encoder it now calls — would be the fixture agreeing with
 * the implementation, which is the failure the spec names by name.
 *
 * The whole point of this file is one key across two SDKs. A divergence here does not
 * error: both sides emit well-formed markers, the strings differ, and the phrase registers
 * twice.
 */

import { describe, expect, it } from 'vitest';
import { parseFragment, serialize } from 'parse5';
import { encodePhrase } from '../src/phrase.js';

/** Measured by the core lane on the pre-refactor encoder. Do not recompute. */
const GOLDEN: [html: string, phrase: string, slots: number][] = [
    ['<p>a <em> b</em></p>', '{m0o}a {m1o} b{m1c}{m0c}', 2],
    ['A <a href="/x">B <em>C</em> D</a> E', 'A {m0o}B {m1o}C{m1c} D{m0c} E', 2],
    ['<b>1<i>2</i>3</b><u>4</u>', '{m0o}1{m1o}2{m1c}3{m0c}{m2o}4{m2c}', 3],
    ['   <b>  x  </b>   ', '{m0o} x {m0c}', 1],
    ['a<!-- note -->b', 'ab', 0],
    ['line<br>break', 'line{m0o}{m0c}break', 1],
    [
        'Hello %name%, you have <b>%count%</b> left',
        'Hello {name}, you have {m0o}{count}{m0c} left',
        1,
    ],
    ['a b <b>c d</b>', 'a b {m0o}c d{m0c}', 1],
];

describe('the golden set — one key across both SDKs', () => {
    it.each(GOLDEN)('%s', (html, phrase, slots) => {
        const encoded = encodePhrase(html);
        expect(encoded.phrase).toBe(phrase);
        expect(encoded.slots).toHaveLength(slots);
    });
});

describe('the constraint a per-node implementation gets wrong', () => {
    it('collapses ONCE over the assembled string, not per text node', () => {
        // Stated as its own test because it is the one an adapter written from the obvious
        // reading fails. The space before `b` belongs INSIDE the inner markers. A per-node
        // trim gives `{m0o}a{m1o}b{m1c}{m0c}` — same nodes, same order, different key, and
        // nothing anywhere reports it.
        expect(encodePhrase('<p>a <em> b</em></p>').phrase).toBe('{m0o}a {m1o} b{m1c}{m0c}');
        expect(encodePhrase('<p>a <em> b</em></p>').phrase).not.toBe('{m0o}a{m1o}b{m1c}{m0c}');
    });

    it('preserves interior spacing that a trim would eat, at both edges of a slot', () => {
        expect(encodePhrase('   <b>  x  </b>   ').phrase).toBe('{m0o} x {m0c}');
    });
});

describe('slot numbering belongs to the encoder', () => {
    it('returns slots in PRE-ORDER — parent before its children', () => {
        // The detail an independently-numbered adapter gets wrong only on nesting, which
        // is why it is asserted on a nested case rather than a flat one.
        const { slots } = encodePhrase('<b>1<i>2</i>3</b><u>4</u>');
        expect(slots.map((n) => n.tagName)).toEqual(['b', 'i', 'u']);
    });

    it('hands back the actual parse5 nodes, not copies', () => {
        // The payload is opaque to the encoder and must survive the round trip, or an
        // adapter cannot map a translated slot back onto the element it came from.
        const { slots } = encodePhrase('<p>x</p>');
        expect(slots[0]).toHaveProperty('tagName', 'p');
        expect(slots[0]).toHaveProperty('childNodes');
    });
});

describe('comments and excluded elements contribute nothing AND consume no index', () => {
    it('a comment does not change the key', () => {
        expect(encodePhrase('a<!-- note -->b').phrase).toBe('ab');
    });

    it('a comment does not shift later slot indices', () => {
        // The sharper half. Giving the comment a slot would still produce well-formed
        // markers — just renumbered from there on, which is a different key for identical
        // content.
        expect(encodePhrase('a<!-- note --><b>c</b>').phrase).toBe(
            encodePhrase('a<b>c</b>').phrase,
        );
    });

    it('script and style bodies contribute nothing', () => {
        expect(encodePhrase('<p>Keep</p><script>var a = 1;</script>').phrase).toBe(
            encodePhrase('<p>Keep</p>').phrase,
        );
    });

    it('CONTROL: ordinary markup DOES take a slot, so "contributes nothing" means something', () => {
        // Without this, every assertion above is satisfied by an encoder that ignores all
        // elements and returns bare text.
        expect(encodePhrase('<p>Keep</p>').slots).toHaveLength(1);
        expect(encodePhrase('Keep').slots).toHaveLength(0);
    });
});

describe('the three families where parse models actually disagree', () => {
    /**
     * **Why this block exists.** The golden set above was measured by the core lane in
     * happy-dom; this adapter runs parse5; neither is a browser. On this exact axis the
     * fleet already has precedent for the models disagreeing — the `<noscript>` reversal,
     * where Chromium and parse5 make the body raw text while happy-dom and libxml2 make it
     * markup, producing different ids for identical source.
     *
     * The core lane audited their 22 inputs and found none of them exercises a
     * divergence-prone construct: all text, comments and inline elements. So the golden
     * set's agreement is real but its COVERAGE stops at inline content, and they filed the
     * rest as a known gap needing a Chromium run neither CI has.
     *
     * This lane has one. Measured in **headless Chromium 153.0.8010.12** via Playwright,
     * injecting the core's browser bundle and calling its DOM-bound `encodeRichText`
     * against this adapter's parse5 output, over the three families:
     *
     *   raw-text elements   textarea, title
     *   foster parenting    non-table content inside <table>
     *   implied close       <p> after <p>, bare <li>, bare <option>
     *
     * **9 of 9 agreed, including two inline controls.** The expectations below are those
     * measured values, pasted as literals.
     *
     * Three controls ran, because an all-agree result is exactly what a broken harness
     * produces: both sides returned a real marker-bearing key rather than two empty
     * strings; the comparison reported DIVERGE when fed different input on each side; and
     * Chromium demonstrably performed the transformations — `<b>stray</b>` moved BEFORE
     * the table, `<p>one<p>two` became two closed paragraphs. parse5 produced byte-identical
     * shapes for both, so the agreement is structural (both implement HTML5 tree
     * construction) rather than two hosts declining to transform.
     *
     * The parse5 shape assertions below are reproducible in CI. The Chromium half is not,
     * and is recorded as provenance rather than re-run — the same posture the core lane
     * took with the golden set.
     */
    const CHROMIUM_AGREED: [html: string, phrase: string][] = [
        ['<p>Keep</p><textarea>a <b>b</b></textarea>', '{m0o}Keep{m0c}{m1o}a <b>b</b>{m1c}'],
        ['<title>a <b>b</b></title><p>Keep</p>', '{m0o}a <b>b</b>{m0c}{m1o}Keep{m1c}'],
        ['<table><b>stray</b><tr><td>cell</td></tr></table>', '{m0o}stray{m0c}{m1o}{m2o}{m3o}{m4o}cell{m4c}{m3c}{m2c}{m1c}'],
        ['<table>loose text<tr><td>x</td></tr></table>', 'loose text{m0o}{m1o}{m2o}{m3o}x{m3c}{m2c}{m1c}{m0c}'],
        ['<p>one<p>two', '{m0o}one{m0c}{m1o}two{m1c}'],
        ['<ul><li>one<li>two</ul>', '{m0o}{m1o}one{m1c}{m2o}two{m2c}{m0c}'],
        ['<select><option>one<option>two</select>', '{m0o}{m1o}one{m1c}{m2o}two{m2c}{m0c}'],
    ];

    it.each(CHROMIUM_AGREED)('%s', (html, phrase) => {
        expect(encodePhrase(html).phrase).toBe(phrase);
    });

    it('raw-text content stays raw — it is not parsed as markup', () => {
        // The property that makes the textarea case interesting rather than incidental.
        expect(encodePhrase('<p>Keep</p><textarea>a <b>b</b></textarea>').phrase).toContain('a <b>b</b>');
    });

    it('CONTROL: parse5 really does foster-parent and imply-close', () => {
        // Without this, "the two models agree" is satisfiable by neither of them doing the
        // transformation — agreement by shared inaction, which proves nothing about a
        // third implementation that does.
        expect(serialize(parseFragment('<table><b>stray</b><tr><td>cell</td></tr></table>'))).toBe(
            '<b>stray</b><table><tbody><tr><td>cell</td></tr></tbody></table>',
        );
        expect(serialize(parseFragment('<p>one<p>two'))).toBe('<p>one</p><p>two</p>');
    });
});

describe('a known PHP divergence, recorded not targeted', () => {
    it('collapses U+2028 as whitespace, which libxml2 does not', () => {
        // Matching the JS family is correct; PHP does not collapse the line terminators.
        // Recorded here so the difference is a decision someone routed rather than a
        // surprise someone discovers.
        expect(encodePhrase('a b').phrase).toBe('a b');
    });
});
