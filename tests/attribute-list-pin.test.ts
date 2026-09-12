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
    HISTORICAL_TRANSLATABLE_ATTRIBUTES_15,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from '../src/constants.js';

/**
 * Transcribed from `langsys-js-typescript@0.6.5` `dist/index.mjs:1138-1156`.
 * Order is identity — `generateCustomId` hashes `JSON.stringify([category, tokens])`,
 * so a set-equal but order-different array yields a different id.
 */
/**
 * Transcribed by hand from `langsys-php`'s `src/Html/HtmlParser.php:26-60`
 * (`DEFAULT_TRANSLATABLE_ATTRIBUTES`), which is the ORIGIN of this list.
 *
 * Deliberately NOT sliced from `TRANSLATABLE_ATTRIBUTES`, and deliberately not copied
 * from the core either — since convergence the constant IS the core's array, so
 * comparing the two would compare a value to itself and pass for any value of it. That
 * is exactly how `langsys-skill`'s list came to invent an entry, omit nine, and miss
 * `value`, with its tests green throughout.
 *
 * Order is identity. A set-equal but order-different array re-keys every block carrying
 * two or more translatable attributes.
 */
const PINNED_27 = [
    // Standard HTML
    'placeholder',
    'alt',
    'title',
    'label',
    // ARIA accessibility
    'aria-label',
    'aria-placeholder',
    'aria-description',
    'aria-valuetext',
    'aria-roledescription',
    // Form validation messages
    'data-error',
    'data-error-message',
    'data-validation-message',
    'data-invalid-message',
    'data-required-message',
    'data-pattern-message',
    // Common framework patterns
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

/**
 * What this package harvested BEFORE convergence. Read-side only.
 *
 * Written out rather than sliced from `PINNED_27`. This records a HISTORICAL FACT — the
 * list that actually produced the ids sitting in customer catalogs — and a slice tracks
 * whatever the current list happens to start with. If the twenty-seven were ever
 * reordered, a slice would silently follow it and this pin would stop pinning anything.
 */
const PINNED_HISTORICAL_15 = [
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

describe('this implementation default equals the pinned list', () => {
    it('is array-identical to PHP\'s list, INCLUDING order', () => {
        expect([...TRANSLATABLE_ATTRIBUTES]).toEqual(PINNED_27);
    });

    it('has exactly twenty-seven entries', () => {
        // States the count so a failure says "28 vs 27" rather than printing two long
        // arrays.
        expect(TRANSLATABLE_ATTRIBUTES).toHaveLength(27);
    });

    it('carries PHP twelve in the ACTIVE list — convergence has landed', () => {
        // The inverse of what this assertion said before. It used to prove we had NOT
        // drifted into shipping the twelve early, because doing so would have disagreed
        // with our own hydration partner on every request. The core shipped them, which
        // is the condition this file was written to detect, so the assertion flips
        // rather than being deleted: shipping them is now the requirement.
        for (const attr of PINNED_27.slice(15)) {
            expect(TRANSLATABLE_ATTRIBUTES).toContain(attr);
        }
    });

    it('keeps the historical fifteen for the read-side fallback only', () => {
        expect([...HISTORICAL_TRANSLATABLE_ATTRIBUTES_15]).toEqual(PINNED_HISTORICAL_15);
        expect(HISTORICAL_TRANSLATABLE_ATTRIBUTES_15).toHaveLength(15);
    });

    it('the historical fifteen are a PREFIX of the twenty-seven, so only the twelve re-key', () => {
        // The mechanical property that kept this migration narrow, asserted rather than
        // asserted-about: PHP's first fifteen are byte-identical to what we shipped, in
        // identical order, and its extras form one contiguous block after them. Nothing
        // already in the list moved, so a block re-keys only if its subtree carries one
        // of the twelve.
        expect(PINNED_27.slice(0, 15)).toEqual([...HISTORICAL_TRANSLATABLE_ATTRIBUTES_15]);
    });

    it('pins the value-bearing element and input-type lists too', () => {
        expect([...VALUE_TRANSLATABLE_ELEMENTS]).toEqual(['button']);
        expect([...VALUE_TRANSLATABLE_INPUT_TYPES]).toEqual(['submit', 'button']);
    });
});

describe('the pin is checked against a DIFFERENT source than the constant', () => {
    it('matches the core subpath artifact, read from node_modules', () => {
        // SPEC.md §10 rule 2: a check must come from a different source than the claim.
        // Since convergence the constant is a re-export OF the core, so this cannot be a
        // second read of the same array — PINNED_27 above is transcribed from PHP's
        // HtmlParser.php, and this reads the built core artifact. Three sources, and the
        // two that are not the constant were written by different people in different
        // languages.
        const dist = readFileSync(
            new URL('../node_modules/langsys-js-typescript/dist/pure.mjs', import.meta.url),
            'utf8',
        );

        const match = dist.match(/TRANSLATABLE_ATTRIBUTES = \[([\s\S]*?)\]/);
        // Prove the probe ran. Without this, a regex that stopped matching yields an
        // empty list that trivially "agrees" with nothing.
        expect(match, 'TRANSLATABLE_ATTRIBUTES not found in the core subpath dist').toBeTruthy();

        const published = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(published).toHaveLength(27);
        expect(published).toEqual(PINNED_27);
        expect([...TRANSLATABLE_ATTRIBUTES]).toEqual(published);
    });
});
