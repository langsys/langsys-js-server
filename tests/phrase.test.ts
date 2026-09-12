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

describe('a known PHP divergence, recorded not targeted', () => {
    it('collapses U+2028 as whitespace, which libxml2 does not', () => {
        // Matching the JS family is correct; PHP does not collapse the line terminators.
        // Recorded here so the difference is a decision someone routed rather than a
        // surprise someone discovers.
        expect(encodePhrase('a b').phrase).toBe('a b');
    });
});
