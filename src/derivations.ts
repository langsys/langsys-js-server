/**
 * Content-block identity, with read-side fallbacks.
 *
 * A `custom_id` is derived from `(category, tokens)`, and `tokens` depends on choices
 * that have changed before and will change again: the hash input encoding, the
 * translatable-attribute list, whether `<select>` options are harvested twice, whether
 * `<script>` bodies count as prose. Each change re-keys some blocks.
 *
 * **The failure mode is why this file exists: a re-keyed block does not error. It
 * renders in the base language and re-registers.** That is indistinguishable from a
 * phrase that was simply never translated — no exception, no warning, no failed
 * request. The catalog quietly grows a duplicate and the page quietly loses its
 * translation.
 *
 * So: REGISTER under the primary derivation only, but READ under every derivation this
 * package knows about before concluding a block is new. Recommended by the `langsys-php`
 * owner, who has watched exactly this migration happen once already:
 *
 *   > Build the dual-read from day one — compute under the current list, and on a miss,
 *   > look up under the other list before treating it as new. Cheap now; a migration
 *   > you'll pay for by hand later. And it costs nothing if you never need it.
 */

import { generateCustomId, generateLegacyCustomId } from './vendor/pure.js';
import { tokenizeHtml } from './tokenizer.js';
import { PHP_ONLY_TRANSLATABLE_ATTRIBUTES, TRANSLATABLE_ATTRIBUTES } from './constants.js';

/** The 27-entry list convergence will land on. Read-side only until it does. */
const CONVERGED_TRANSLATABLE_ATTRIBUTES = [
    ...TRANSLATABLE_ATTRIBUTES,
    ...PHP_ONLY_TRANSLATABLE_ATTRIBUTES,
] as const;

export interface Derivation {
    id: string;
    tokens: string[];
    /** Stable name, so a log line can say WHICH derivation resolved a block. */
    label: string;
}

export interface BlockIdentity {
    /** The derivation this package registers under. Never a fallback. */
    primary: Derivation;
    /**
     * Additional derivations to try on a catalog miss, in order. Each corresponds to a
     * real historical or sibling behaviour, not a speculative one.
     */
    fallbacks: Derivation[];
}

export function deriveBlockIdentity(innerHtml: string, category: string): BlockIdentity {
    const primaryTokens = tokenizeHtml(innerHtml);

    const primary: Derivation = {
        id: generateCustomId(category, primaryTokens),
        tokens: primaryTokens,
        label: 'current',
    };

    const fallbacks: Derivation[] = [];
    const seen = new Set<string>([primary.id]);

    const add = (label: string, tokens: string[], id: string): void => {
        // A derivation that collapses onto one already tried is not a second lookup —
        // it is the same lookup with a different name, and adding it would make the
        // fallback count look like coverage it does not have.
        if (seen.has(id)) return;
        seen.add(id);
        fallbacks.push({ id, tokens, label });
    };

    // 1. Siblings do not skip <script>/<style>. A block registered by the client SDK or
    //    by langsys-php over the same markup carries their tokens, so read under them.
    const unskippedTokens = tokenizeHtml(innerHtml, { skipCodeElements: false });
    add('sibling-no-skip', unskippedTokens, generateCustomId(category, unskippedTokens));

    // 2. When the attribute lists converge on PHP's 27, every block whose subtree
    //    carries one of the twelve re-keys. Reading under the converged list NOW means
    //    that day is a no-op for lookups instead of a catalog migration.
    //
    //    Note this is the *same* generateCustomId over a SHORTER/LONGER attribute list —
    //    a second token DERIVATION, not a second hash. That distinction matters for
    //    retirement: retiring an encoding fallback requires rebasing every block;
    //    retiring a derivation fallback requires rebasing only the blocks it covers.
    const convergedTokens = tokenizeHtml(innerHtml, {
        translatableAttributes: CONVERGED_TRANSLATABLE_ATTRIBUTES,
    });
    add('converged-27', convergedTokens, generateCustomId(category, convergedTokens));

    // 3. Pre-0.6.3 blocks: <select> option text was harvested twice, and the hash input
    //    was `tokens.join('-')` rather than JSON.stringify. Both must be reproduced
    //    together — this is the `generateLegacyCustomId` case.
    const legacyTokens = tokenizeHtml(innerHtml, {
        duplicateSelectOptions: true,
        skipCodeElements: false,
    });
    add('legacy-hash', legacyTokens, generateLegacyCustomId(category, legacyTokens));

    return { primary, fallbacks };
}
