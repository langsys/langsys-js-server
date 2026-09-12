/**
 * CID-2 — `'__uncategorized__'` is a cache-lookup namespace and is never a hash input.
 *
 * **In its own file, deliberately.** These assertions used to live beside the shared
 * fixture suites, where a missing sibling checkout crashed the file during collection and
 * took them down with it — so the rule most likely to regress quietly was the one whose
 * tests depended on two other repositories being present. Nothing here needs a sibling.
 *
 * The rule's own recorded failure is that people verify the wrong thing: three separate
 * agents read `generateCustomId`, found it unguarded, and concluded the SDK emitted a
 * null-category hash. It did not — every shipping caller defaulted the category first.
 * *Measuring the right function is not measuring the right call.* So these assert at the
 * caller, and they assert the WHOLE derivation set rather than the primary id.
 *
 * That distinction is not theoretical. The core coalesces the sentinel inside
 * `generateCustomId`, so the primary id was already correct — but `generateLegacyCustomId`
 * deliberately does not coalesce, because it has to reproduce ids an untyped caller
 * actually stored. Passing the sentinel through therefore produced an extra legacy
 * fallback (`85a2334d…`) that an empty category never produces: equal primaries, unequal
 * fallback sets. A test comparing only `primary.id` was green throughout.
 */

import { describe, expect, it } from 'vitest';
import { deriveBlockIdentity, generateCustomId, UNCATEGORIZED } from '../../src/index.js';

const HTML = '<p>Hello</p>';
const ids = (category: string) => {
    const { primary, fallbacks } = deriveBlockIdentity(HTML, category);
    return { primary: primary.id, fallbacks: fallbacks.map((f) => f.id) };
};

describe('CID-2 — the sentinel never reaches the hasher as a category', () => {
    it('hashes identically to an empty category at the id function', () => {
        expect(generateCustomId(UNCATEGORIZED, ['Hello'])).toBe(generateCustomId('', ['Hello']));
    });

    it('produces the same PRIMARY id through deriveBlockIdentity', () => {
        expect(ids(UNCATEGORIZED).primary).toBe(ids('').primary);
    });

    it('produces the same FALLBACK SET — the half a primary-only test misses', () => {
        // The legacy hasher does not coalesce. Without normalisation at the boundary this
        // is `['85a2334d…']` against `[]`: a lookup the sentinel performs and the empty
        // category does not, on a derivation that is supposed to be a function of the
        // same inputs.
        expect(ids(UNCATEGORIZED).fallbacks).toEqual(ids('').fallbacks);
    });

    it('CONTROL: a real category still produces a different id', () => {
        // Without this, "the sentinel is normalised" is satisfiable by a hasher that
        // ignores the category entirely.
        expect(ids('nav').primary).not.toBe(ids('').primary);
    });

    it('CONTROL: the fallback comparison can fail', () => {
        // And without THIS, the fallback assertion above is satisfiable by a
        // deriveBlockIdentity that returns no fallbacks for anything. A <select> block
        // has a real legacy shape, so its set is non-empty.
        const withLegacy = deriveBlockIdentity(
            '<select><option>Café</option><option>Thé</option></select>',
            '',
        );
        expect(withLegacy.fallbacks.length).toBeGreaterThan(0);
    });
});
