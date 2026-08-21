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
import { generateCustomId, generateLegacyCustomId } from '../src/vendor/pure.js';
import { PHP_ONLY_TRANSLATABLE_ATTRIBUTES, TRANSLATABLE_ATTRIBUTES } from '../src/constants.js';

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
        // Guards a mutation that swapped the primary onto the converged 27-attribute list:
        // registering under a list we have not shipped would orphan every block on the day
        // the client family converges.
        const { primary } = deriveBlockIdentity('<div data-tooltip="Hi">x</div>', 'cat');
        expect(primary.tokens).toEqual(['x']);
        expect(primary.id).toBe(generateCustomId('cat', ['x']));
    });
});

describe('sibling-no-skip — blocks registered by the client SDK or langsys-php', () => {
    it('is offered when the markup contains a script', () => {
        const html = '<p>Keep</p><script>var a=1;</script>';
        const { fallbacks } = deriveBlockIdentity(html, 'cat');
        const sibling = fallbacks.find((f) => f.label === 'sibling-no-skip');

        expect(sibling, 'sibling-no-skip missing — a block registered by either sibling would not resolve').toBeTruthy();
        expect(sibling!.tokens).toEqual(['Keep', 'var a=1;']);
        expect(sibling!.id).toBe(generateCustomId('cat', ['Keep', 'var a=1;']));
    });

    it('reproduces the sibling output byte-for-byte', () => {
        const html = '<p>Keep</p><style>.a{}</style>';
        const sibling = deriveBlockIdentity(html, 'cat').fallbacks.find(
            (f) => f.label === 'sibling-no-skip',
        );
        expect(sibling!.tokens).toEqual(tokenizeHtml(html, { skipCodeElements: false }));
    });

    it('is NOT offered when there is nothing to skip', () => {
        // The dedup guard. Without it the fallback list looks like coverage it does not
        // have, and every lookup pays for derivations that collapse onto the primary.
        expect(labelsOf('<p>Plain text</p>')).not.toContain('sibling-no-skip');
    });
});

describe('converged-27 — the day the attribute lists converge', () => {
    it('is offered when the markup carries one of PHP twelve', () => {
        const html = '<div data-tooltip="Hi">x</div>';
        const converged = deriveBlockIdentity(html, 'cat').fallbacks.find(
            (f) => f.label === 'converged-27',
        );

        expect(converged, 'converged-27 missing — the convergence would be a catalog migration rather than a no-op').toBeTruthy();
        expect(converged!.tokens).toEqual(['Hi', 'x']);
        expect(converged!.id).toBe(
            generateCustomId('cat', tokenizeHtml(html, {
                translatableAttributes: [...TRANSLATABLE_ATTRIBUTES, ...PHP_ONLY_TRANSLATABLE_ATTRIBUTES],
            })),
        );
    });

    it('covers every one of the twelve, not just the one that was easy to test', () => {
        for (const attr of PHP_ONLY_TRANSLATABLE_ATTRIBUTES) {
            const html = `<div ${attr}="Value">x</div>`;
            const converged = deriveBlockIdentity(html, 'cat').fallbacks.find(
                (f) => f.label === 'converged-27',
            );
            expect(converged, `no converged-27 derivation for ${attr}`).toBeTruthy();
            expect(converged!.tokens).toEqual(['Value', 'x']);
        }
    });

    it('is NOT offered for markup carrying none of them — the negative control', () => {
        // Without this, a derivation that always used 27 attributes would also pass above.
        expect(labelsOf('<div title="T">x</div>')).not.toContain('converged-27');
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
