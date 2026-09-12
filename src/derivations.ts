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

import { generateCustomId, generateLegacyCustomId } from 'langsys-js-typescript/pure';
import { tokenizeHtml } from './tokenizer.js';
import { HISTORICAL_TRANSLATABLE_ATTRIBUTES_15, UNCATEGORIZED } from './constants.js';

/** The 27-entry list convergence will land on. Read-side only until it does. */


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

export function deriveBlockIdentity(innerHtml: string, rawCategory: string): BlockIdentity {
    // CID-2 at the BOUNDARY, not at one hasher.
    //
    // `'__uncategorized__'` is a cache-lookup namespace and must never be a hash input.
    // The core coalesces it inside `generateCustomId`, so the primary id was already
    // correct — but `generateLegacyCustomId` deliberately does NOT coalesce (it has to
    // reproduce what an untyped caller actually stored), so passing the sentinel through
    // produced an extra legacy fallback that an empty category never produces. Two
    // callers, one guarded and one not, is exactly the shape CID-2 warns about: the
    // export everyone reads was fine, and the divergence lived in the caller.
    //
    // Normalising here makes the WHOLE derivation set a function of the same category,
    // which is the property `tests/conformance/cid-2.test.ts` asserts — equal fallback
    // sets, not merely equal primary ids.
    const category = rawCategory === UNCATEGORIZED ? '' : rawCategory;
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

    // The two DIVERGENCE fallbacks that used to sit here are gone, and their absence is
    // the point: `sibling-no-skip` existed because the siblings tokenized <script> and
    // <style> contents and this package did not, and `converged-27` existed because the
    // attribute lists had not converged. Both divergences ended when the core shipped
    // `langsys-js-typescript/pure` — the skip list and the twenty-seven now come FROM the
    // core, so there is no second shape to read under. A fallback for a divergence that
    // no longer exists is not caution, it is a lookup that can only ever return the same
    // id as the primary.
    //
    // The HISTORICAL fallbacks below are deliberately kept. They are a different thing:
    // not a disagreement between implementations, but a record of what this package
    // actually stored before the hash and the token shape were corrected. CID-3 requires
    // tolerating those on lookup, and v8 widened that obligation to the reading side for
    // every profile. Deleting them would orphan real catalog entries rather than retire a
    // divergence.

    // 3. The two historical shapes that used LEGACY tokens (<select> option text
    //    harvested twice, pre-0.6.3). There are two, not one, because the md5 fix and the
    //    token fix shipped at DIFFERENT versions — confirmed against the published SDK's
    //    own `handleContentBlock`, whose fallback candidates are exactly:
    //
    //        generateCustomId(category, legacyTokens)        <- 0.6.0 - 0.6.2
    //        generateLegacyCustomId(category, legacyTokens)  <- pre-0.6.0
    //
    //    (`legacy md5 + corrected tokens` never existed: the hash fix landed first.)
    //
    //    Missing the first of those meant a block containing a <select> registered by
    //    0.6.0-0.6.2 resolved in the client SDK and did NOT resolve here. It does not
    //    dedup away either — legacyTokens differ from primary tokens whenever a <select>
    //    or a <script> is present, so the id is genuinely distinct.
    //
    //    Note `md5Legacy` differs from `md5` only for NON-ASCII input, so for an
    //    all-ASCII block the third derivation collapses onto the second. That is correct
    //    and is why `add()` dedups by id.
    //    Pinned to the FIFTEEN, not to the current list. These derivations reproduce
    //    what was stored, and what was stored was keyed from fifteen attributes. Letting
    //    them track the live list would make them a hybrid that never existed on any
    //    version — a lookup shape matching no catalog entry ever written.
    const legacyTokens = tokenizeHtml(innerHtml, {
        duplicateSelectOptions: true,
        skipCodeElements: false,
        translatableAttributes: HISTORICAL_TRANSLATABLE_ATTRIBUTES_15,
    });
    add('legacy-tokens-current-hash', legacyTokens, generateCustomId(category, legacyTokens));
    add('legacy-tokens-legacy-hash', legacyTokens, generateLegacyCustomId(category, legacyTokens));

    return { primary, fallbacks };
}
