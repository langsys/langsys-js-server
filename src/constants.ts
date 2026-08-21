/**
 * Identity-bearing constants.
 *
 * Everything in this file participates in `custom_id` derivation, which means a
 * change here re-keys catalog entries. There is deliberately **no runtime setter**
 * for any of it.
 *
 * `langsys-php` exposes `setTranslatableAttributes()`, which makes `custom_id` a
 * function of host configuration rather than of content — two PHP apps configured
 * differently disagree with *each other*, not merely with JS. This package does not
 * repeat that. See SPEC.md §9.
 */

/**
 * Attributes whose values are harvested as translatable tokens.
 *
 * **This is the 15-entry list, matching `langsys-js-typescript@0.6.5` exactly and in
 * identical order.** It is NOT PHP's 27.
 *
 * SPEC.md §9 records a decision to converge on PHP's 27, and that decision stands —
 * but it is not yet satisfiable, and shipping it early would be actively wrong:
 *
 *  - Verified against the published npm artifact (not a working tree, which led the
 *    registry by nine commits): `langsys-js-typescript@0.6.5` `dist/index.mjs:1138`
 *    carries these 15. All twelve PHP-only names occur **zero** times in the dist.
 *  - The base SDK has the convergence backlogged as *not started*, blocked on a
 *    catalog-migration count from the Translation Manager.
 *  - SPEC.md §9's own sequencing constraint: this package "must not ship 27 before
 *    the client SDKs do, or it disagrees with its own hand-off partner on every
 *    request."
 *
 * Hydration hand-off is a **per-request** event; PHP interop is a deployment-topology
 * one. So while the client family carries 15, matching it is the correct trade.
 *
 * When the base SDK ships the twelve, they APPEND — PHP's first 15 are byte-identical
 * to these in identical order, and its extras form one contiguous block after them.
 * Nothing already in this list moves, so only blocks carrying one of the twelve re-key.
 * `derivations.ts` carries the read-side fallback for exactly that day.
 */
export const TRANSLATABLE_ATTRIBUTES = [
    'placeholder',
    'alt',
    'title',
    'label', // <option>, <optgroup>, <track> — the text a user reads in the picker
    'aria-label',
    'aria-placeholder',
    'aria-description',
    'aria-valuetext', // the spoken value of a slider/meter
    'aria-roledescription',
    'data-error',
    'data-error-message',
    'data-validation-message',
    'data-invalid-message',
    'data-required-message',
    'data-pattern-message',
] as const;

/**
 * PHP's additional twelve, kept here as data rather than as prose so the read-side
 * fallback in `derivations.ts` can be built and tested before convergence lands.
 *
 * NOT part of the active list. Nothing registers under a derivation using these.
 */
export const PHP_ONLY_TRANSLATABLE_ATTRIBUTES = [
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
] as const;

/** Elements whose `value` attribute carries user-visible text. */
export const VALUE_TRANSLATABLE_ELEMENTS = ['button'] as const;

/** `<input type="...">` values whose `value` attribute is a visible label. */
export const VALUE_TRANSLATABLE_INPUT_TYPES = ['submit', 'button'] as const;

/**
 * Attributes marking a subtree as a self-managed "keep-together" phrase, which the
 * block tokenizer must skip rather than split at tag boundaries.
 *
 * Both spellings are RECOGNISED. `langsys-js-typescript` reads both
 * (`dist/index.mjs:1157`), and the marker never enters `tokens[]`, so accepting both
 * costs nothing in identity.
 *
 * Writing is a different question — see `PHRASE_MARKER_ATTRS_EMIT`.
 */
export const PHRASE_MARKER_ATTRS = ['data-ls-phrase', 'data-langsys-phrase'] as const;

/**
 * Marker spellings this package WILL emit. Both, deliberately.
 *
 * **Nothing emits them yet.** 0.1.0 renders no HTML — `<Phrase>` and `<Translate>` land in
 * 0.2.0 — so this constant records the decision rather than implementing it. Stated
 * plainly because a documented mitigation whose only artifact is a constant naming it is
 * this project's own failure class: it reads as done.
 *
 * `langsys-php` does not recognise `data-ls-phrase` at all — the string does not occur
 * in its `src/`. So emitting only the JS spelling is the single combination that is
 * silently wrong in a topology that ships today: the reference deployment runs
 * `adapter-node` **behind a PHP proxy**, and a page this package renders passing
 * through a PHP layer calling `translatePage()` would have its kept-whole sentences
 * re-split — the exact failure `<Phrase>` exists to prevent, arriving from the one
 * direction nobody watches.
 *
 * Emitting both is free: the JS reader accepts either, and neither reaches `tokens[]`.
 */
export const PHRASE_MARKER_ATTRS_EMIT = ['data-langsys-phrase', 'data-ls-phrase'] as const;

/**
 * Elements whose text content is code or styling, never prose.
 *
 * **This is a deliberate, documented divergence from BOTH sibling implementations,
 * and the only place this package knowingly differs on identity.**
 *
 * Neither `langsys-php`'s `HtmlParser::walkNode()` nor `langsys-js-typescript`'s
 * `_walkForTokens` skips these on the content-block path. PHP's `PageTranslator` has
 * a `SKIP_ELEMENTS` list, but `extractAsContentBlock()` bypasses it. Measured by the
 * PHP owner on their public API, a block containing analytics JS queues this for
 * permanent registration in the shared catalog:
 *
 *     window.dataLayer.push({event:"view",sku:"ABC-123"});
 *     .plan{color:#fff}
 *
 * `tokenizer-reference.json` case [12] asserts that output as the contract, so a
 * correct tokenizer FAILS that case. The PHP owner has confirmed the fixture encodes
 * a defect, corrected their README, and explicitly asked this package not to
 * reproduce it: "don't implement bug-compatibility here."
 *
 * The cost of skipping is that a `<Translate>` block containing a `<script>` derives a
 * different `custom_id` here than in the client SDK we hydrate over. That is mitigated
 * rather than ignored — `derivations.ts` reads under the no-skip derivation as a
 * fallback, so an existing catalog entry still resolves. Registration always uses the
 * corrected derivation.
 */
export const SKIP_ELEMENTS = ['script', 'style', 'template'] as const;

/*
 * Two elements that look like they belong above and do not:
 *
 * `<noscript>` is NOT skipped. Its content is user-visible — it renders whenever
 * scripting is off, and "Enable JavaScript to continue" is exactly the kind of string
 * that should be translated. It pattern-matches as technical, which is why it was in
 * this list in the first draft; the base SDK owner caught it. Measured: the DOM walker
 * yields ["Keep","Enable JS"] for `<p>Keep</p><noscript>Enable JS</noscript>`, and that
 * is correct behaviour, not a defect to mirror.
 *
 * `<template>` IS skipped, but not for the reason the others are. In a DOM, template
 * content lives in a separate `DocumentFragment` on `HTMLTemplateElement.content`, so
 * `childNodes` is empty and the base SDK's walker finds nothing — it emits no tokens
 * without skipping anything. parse5 models this the same way (content hangs off
 * `node.content`, not `childNodes`), so this package ALREADY agrees with the DOM path
 * even with `skipCodeElements: false` — verified by execution, not assumed.
 *
 * The entry stays anyway, because that agreement is an accident of two parsers happening
 * to model the spec identically. A forgiving parser (`htmlparser2`) treats `<template>`
 * as an ordinary element and would harvest its contents — a divergence in the opposite
 * direction from the one this list exists for, and one no fixture would think to pin
 * because both sides "obviously" agree today. Listing it makes an accidental behaviour
 * intentional and parser-independent. Do not remove it as dead weight after testing only
 * in a browser.
 */

/** Catalog bucket for phrases registered with no category. */
export const UNCATEGORIZED = '__uncategorized__';
