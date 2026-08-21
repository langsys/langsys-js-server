/**
 * The attribute-list pin.
 *
 * SPEC.md §5 establishes that pinning takes TWO assertions which must live in different
 * places, and that even both together are not sufficient:
 *
 *  1. Shared fixtures run against an explicitly pinned list — cross-SDK parity of the
 *     tokenizer GIVEN a list. That lives in `tests/conformance/`, and it is shareable.
 *  2. A local, per-SDK assertion that THIS implementation's default equals the pinned
 *     list, array-identical including order. That is this file. It is a claim about one
 *     implementation's default, not about the contract, so it is deliberately NOT
 *     shareable.
 *  3. A third assertion that every pinned attribute actually PRODUCES a token, with a
 *     negative control that an unlisted attribute does not — because a pin is a list
 *     comparison, and it passes just as happily when the walker has stopped consulting
 *     the list. Measured by the PHP owner:
 *
 *         walker reads only first 3 entries, list untouched
 *           -> harvest test fails, PIN TEST STILL PASSES
 *
 *     That assertion lives in the conformance corpus ("all fifteen translatable
 *     attributes" plus "unlisted attribute produces NO token").
 *
 * The literal is written out below rather than sliced from the constant. Slicing it
 * compares the constant to itself and passes for any value of it — which is exactly how
 * `langsys-skill`'s list came to invent an entry, omit nine, and miss `value` entirely
 * while its tests stayed green.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    TRANSLATABLE_ATTRIBUTES,
    PHP_ONLY_TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from '../src/constants.js';

/**
 * Transcribed from `langsys-js-typescript@0.6.5` `dist/index.mjs:1138-1156`.
 * Order is identity — `generateCustomId` hashes `JSON.stringify([category, tokens])`,
 * so a set-equal but order-different array yields a different id.
 */
const PINNED_15 = [
    'placeholder',
    'alt',
    'title',
    'label',
    'aria-label',
    'aria-placeholder',
    'aria-description',
    'aria-valuetext',
    'aria-roledescription',
    'data-error',
    'data-error-message',
    'data-validation-message',
    'data-invalid-message',
    'data-required-message',
    'data-pattern-message',
];

/** PHP's additional twelve, from `langsys-php@v1.3.1` `src/Html/HtmlParser.php:26-60`. */
const PINNED_PHP_EXTRA_12 = [
    'data-confirm',
    'data-tooltip',
    'data-title',
    'data-content',
    'data-original-title',
    'data-bs-title',
    'data-bs-content',
    'data-loading-text',
    'data-success-message',
    'data-warning-message',
    'data-empty-message',
    'data-placeholder',
];

describe('this implementation default equals the pinned list', () => {
    it('is array-identical, INCLUDING order', () => {
        expect([...TRANSLATABLE_ATTRIBUTES]).toEqual(PINNED_15);
    });

    it('has exactly fifteen entries', () => {
        // Guards the direction `toEqual` already covers, but states the count so a
        // failure message says "16 vs 15" rather than printing two long arrays.
        expect(TRANSLATABLE_ATTRIBUTES).toHaveLength(15);
    });

    it('carries none of PHP twelve in the ACTIVE list', () => {
        // The convergence on PHP's 27 is decided but not yet satisfiable: the base SDK
        // has it backlogged as not-started, and shipping it first would disagree with
        // our own hydration partner on every request. This asserts we have not drifted
        // into shipping it early.
        for (const attr of PINNED_PHP_EXTRA_12) {
            expect(TRANSLATABLE_ATTRIBUTES).not.toContain(attr);
        }
    });

    it('keeps PHP twelve available for the read-side fallback', () => {
        expect([...PHP_ONLY_TRANSLATABLE_ATTRIBUTES]).toEqual(PINNED_PHP_EXTRA_12);
    });

    it('appends cleanly when convergence lands — nothing already in the list moves', () => {
        // The mechanical property that makes the eventual migration narrow: PHP's first
        // 15 are byte-identical to ours in identical order, and its extras form one
        // contiguous block after them. So only blocks carrying one of the twelve re-key.
        const converged = [...TRANSLATABLE_ATTRIBUTES, ...PHP_ONLY_TRANSLATABLE_ATTRIBUTES];
        expect(converged).toHaveLength(27);
        expect(converged.slice(0, 15)).toEqual(PINNED_15);
    });

    it('pins the value-bearing element and input-type lists too', () => {
        expect([...VALUE_TRANSLATABLE_ELEMENTS]).toEqual(['button']);
        expect([...VALUE_TRANSLATABLE_INPUT_TYPES]).toEqual(['submit', 'button']);
    });
});

describe('the pin is checked against a DIFFERENT source than the constant', () => {
    it('matches the published base SDK artifact, read from node_modules', () => {
        // SPEC.md §10 rule 2: a check must come from a different source than the claim.
        // Both the constant and PINNED_15 above were written in this repo, so on their
        // own they could share an error. This reads the published package.
        const dist = readFileSync(
            new URL('../node_modules/langsys-js-typescript/dist/index.mjs', import.meta.url),
            'utf8',
        );

        const match = dist.match(/var TRANSLATABLE_ATTRIBUTES = \[([\s\S]*?)\];/);
        // Prove the probe ran. Without this, a regex that stopped matching would yield
        // an empty list that trivially "agrees" with nothing.
        expect(match, 'TRANSLATABLE_ATTRIBUTES not found in the published dist').toBeTruthy();

        const published = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(published).toHaveLength(15);
        expect(published).toEqual(PINNED_15);
        expect([...TRANSLATABLE_ATTRIBUTES]).toEqual(published);
    });

    it('confirms the published dist does NOT yet carry the twelve', () => {
        // This is the assertion that would have caught the spec contradiction. When it
        // fails, the base SDK has shipped the convergence and this package should follow.
        const dist = readFileSync(
            new URL('../node_modules/langsys-js-typescript/dist/index.mjs', import.meta.url),
            'utf8',
        );
        const match = dist.match(/var TRANSLATABLE_ATTRIBUTES = \[([\s\S]*?)\];/);
        const published = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

        for (const attr of PINNED_PHP_EXTRA_12) {
            expect(
                published,
                `The base SDK now ships "${attr}". The attribute lists have converged — ` +
                    'move the twelve into TRANSLATABLE_ATTRIBUTES, bump the base-SDK floor, ' +
                    'and delete this assertion.',
            ).not.toContain(attr);
        }
    });
});
