/**
 * `deriveBlockIdentity` — the dual-read migration safety net.
 *
 * This is exported public API and, before this file, **nothing tested it**: returning
 * `fallbacks: []` outright kept the suite green, as did deleting the dedup guard, as did
 * swapping `generateLegacyCustomId` for `generateCustomId`. The one thing both sibling
 * SDK owners specifically asked for was the piece with no coverage.
 *
 * The reason it matters is the failure mode it prevents, which produces no signal:
 * **a re-keyed block does not error. It renders in the base language and re-registers** —
 * indistinguishable from a phrase that was simply never translated.
 *
 * Expectations for the historical shapes come from the published SDK's own
 * `handleContentBlock` (`dist/index.mjs`), whose fallback candidate list is exactly:
 *
 *     generateCustomId(category, legacyTokens)        <- 0.6.0 - 0.6.2
 *     generateLegacyCustomId(category, legacyTokens)  <- pre-0.6.0
 */

import { describe, expect, it } from 'vitest';
import { deriveBlockIdentity } from '../src/derivations.js';
import { tokenizeHtml } from '../src/tokenizer.js';
import { generateCustomId, generateLegacyCustomId } from 'langsys-js-typescript/pure';
import { HISTORICAL_TRANSLATABLE_ATTRIBUTES_15 } from '../src/constants.js';

const labelsOf = (html: string, category = 'cat') =>
    deriveBlockIdentity(html, category).fallbacks.map((f) => f.label);

describe('the primary derivation', () => {
    it('uses the corrected tokens — script skipped, 15 attributes', () => {
        const { primary } = deriveBlockIdentity('<p>Keep</p><script>var a=1;</script>', 'cat');
        expect(primary.label).toBe('current');
        expect(primary.tokens).toEqual(['Keep']);
        expect(primary.id).toBe(generateCustomId('cat', ['Keep']));
    });

    it('is what registration would use, never a fallback', () => {
        // Before convergence this asserted the OPPOSITE — that `data-tooltip` produced no
        // token, because registering under a list the client family had not shipped would
        // have orphaned every block on the day it did. The core shipped the twenty-seven,
        // so the same assertion now runs the other way: the attribute IS harvested, and
        // the primary is what registration uses.
        const { primary } = deriveBlockIdentity('<div data-tooltip="Hi">x</div>', 'cat');
        expect(primary.tokens).toEqual(['Hi', 'x']);
        expect(primary.id).toBe(generateCustomId('cat', ['Hi', 'x']));
    });
});

describe('the divergence fallbacks are GONE, because the divergences are', () => {
    /**
     * `sibling-no-skip` and `converged-27` were read-side tolerance for two real
     * disagreements: the siblings tokenized `<script>`/`<style>` contents and this
     * package did not, and the attribute lists had not converged. Both ended when the
     * core shipped `langsys-js-typescript/pure` — the skip list and the twenty-seven now
     * come FROM the core, so there is no second shape to read under.
     *
     * These assertions are the inverse of the ones they replace, and they are worth
     * keeping rather than deleting: a fallback for a divergence that no longer exists
     * returns the same id as the primary, so it costs a lookup and reports coverage it
     * does not have.
     */
    it('offers no sibling-no-skip derivation for script-bearing markup', () => {
        expect(labelsOf('<p>Keep</p><script>var a=1;</script>')).not.toContain('sibling-no-skip');
    });

    it('offers no converged-27 derivation for markup carrying one of the twelve', () => {
        expect(labelsOf('<div data-tooltip="Hi">x</div>')).not.toContain('converged-27');
    });

    it('agrees with the core on script-bearing markup, which is WHY the fallback went', () => {
        // The load-bearing half. Asserting the fallback is absent proves only that it was
        // deleted; this proves it was safe to delete — our tokens for the same markup are
        // now what the core derives, so there is nothing left to read under.
        const html = '<p>Keep</p><script>var a=1;</script><style>.a{}</style>';
        expect(tokenizeHtml(html)).toEqual(['Keep']);
    });

    it('POSITIVE CONTROL: fallbacks are still offered where a real shape exists', () => {
        // Without this, "no fallback" is satisfiable by a deriveBlockIdentity that
        // returns an empty array for everything.
        const labels = labelsOf('<select><option>One</option><option>Two</option></select>');
        expect(labels.length).toBeGreaterThan(0);
    });
});

describe('the two historical LEGACY-token shapes', () => {
    const SELECT = '<select><option>One</option><option>Two</option></select>';

    it('offers the 0.6.0-0.6.2 shape: legacy tokens, CURRENT hash', () => {
        // This one was missing. A block containing a <select> registered by 0.6.0-0.6.2
        // resolved in the client SDK and did NOT resolve here.
        const legacyTokens = tokenizeHtml(SELECT, {
            duplicateSelectOptions: true,
            skipCodeElements: false,
            translatableAttributes: HISTORICAL_TRANSLATABLE_ATTRIBUTES_15,
        });
        const found = deriveBlockIdentity(SELECT, 'cat').fallbacks.find(
            (f) => f.label === 'legacy-tokens-current-hash',
        );

        expect(found, 'the 0.6.0-0.6.2 derivation is missing').toBeTruthy();
        expect(found!.id).toBe(generateCustomId('cat', legacyTokens));
    });

    it('offers the pre-0.6.0 shape: legacy tokens, LEGACY hash', () => {
        // md5Legacy equals md5 for ASCII, so this collapses onto the row above for plain
        // English markup and is deduped. Non-ASCII option text separates them.
        const html = '<select><option>Café</option><option>Thé</option></select>';
        const legacyTokens = tokenizeHtml(html, {
            duplicateSelectOptions: true,
            skipCodeElements: false,
            translatableAttributes: HISTORICAL_TRANSLATABLE_ATTRIBUTES_15,
        });
        const found = deriveBlockIdentity(html, 'cat').fallbacks.find(
            (f) => f.label === 'legacy-tokens-legacy-hash',
        );

        expect(found, 'the pre-0.6.0 derivation is missing for non-ASCII content').toBeTruthy();
        expect(found!.id).toBe(generateLegacyCustomId('cat', legacyTokens));
        expect(found!.id).not.toBe(generateCustomId('cat', legacyTokens));
    });

    it('matches the published SDK own fallback candidates for a <select>', () => {
        // The expectations here are derived from the SDK's `handleContentBlock`, not from
        // this repo's idea of what the history was.
        const legacyTokens = tokenizeHtml(SELECT, {
            duplicateSelectOptions: true,
            skipCodeElements: false,
            translatableAttributes: HISTORICAL_TRANSLATABLE_ATTRIBUTES_15,
        });
        const sdkCandidates = [
            generateCustomId('cat', legacyTokens),
            generateLegacyCustomId('cat', legacyTokens),
        ];

        const ourIds = deriveBlockIdentity(SELECT, 'cat').fallbacks.map((f) => f.id);
        for (const candidate of sdkCandidates) {
            expect(ourIds, `we do not read under ${candidate}`).toContain(candidate);
        }
    });

    it('duplicates <select> option text, which is the legacy defect being reproduced', () => {
        const legacyTokens = tokenizeHtml(SELECT, {
            duplicateSelectOptions: true,
            skipCodeElements: false,
            translatableAttributes: HISTORICAL_TRANSLATABLE_ATTRIBUTES_15,
        });
        // Once from the recursive descent, once from the explicit sweep.
        expect(legacyTokens.filter((t) => t === 'One')).toHaveLength(2);
        // And the corrected tokens must NOT — otherwise the two derivations are identical
        // and the fallback is pointless.
        expect(tokenizeHtml(SELECT).filter((t) => t === 'One')).toHaveLength(1);
    });
});

describe('deduplication', () => {
    it('never offers a fallback whose id equals the primary', () => {
        for (const html of [
            '<p>Plain</p>',
            '<div title="T">x</div>',
            '<p>Keep</p><script>var a=1;</script>',
            '<select><option>One</option></select>',
            '<div data-tooltip="Hi">x</div>',
        ]) {
            const { primary, fallbacks } = deriveBlockIdentity(html, 'cat');
            expect(fallbacks.map((f) => f.id), html).not.toContain(primary.id);
        }
    });

    it('never offers the same id twice', () => {
        for (const html of [
            '<p>Keep</p><script>var a=1;</script>',
            '<select><option>Café</option></select>',
            '<div data-tooltip="Hi">x</div><script>y</script>',
        ]) {
            const ids = deriveBlockIdentity(html, 'cat').fallbacks.map((f) => f.id);
            expect(new Set(ids).size, html).toBe(ids.length);
        }
    });

    it('offers NO fallbacks for markup where every derivation collapses', () => {
        // The strongest statement of the dedup guard: plain prose has exactly one
        // identity, and the fallback list must be honest about that.
        expect(deriveBlockIdentity('<p>Just prose</p>', 'cat').fallbacks).toEqual([]);
    });
});

describe('category participates in every derivation', () => {
    it('changes the primary and all fallback ids', () => {
        const html = '<p>Keep</p><script>var a=1;</script>';
        const a = deriveBlockIdentity(html, 'alpha');
        const b = deriveBlockIdentity(html, 'beta');

        expect(a.primary.id).not.toBe(b.primary.id);
        expect(a.fallbacks.map((f) => f.id)).not.toEqual(b.fallbacks.map((f) => f.id));
    });
});
