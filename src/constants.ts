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
/**
 * The twenty-seven translatable attributes, **in order**, re-exported from the core.
 *
 * Consumed from `langsys-js-typescript/pure` rather than restated here. Order is
 * identity — `generateCustomId` hashes `JSON.stringify([category, tokens])`, so a
 * set-equal but order-different array yields a different id for every block carrying
 * two or more translatable attributes. A local copy is a second source of truth for a
 * value whose whole purpose is to be identical across SDKs, and the way it fails is a
 * silent re-key rather than an error.
 *
 * `tests/attribute-list-pin.test.ts` still pins it against an independently transcribed
 * literal, so a reorder upstream breaks this build loudly instead of re-keying quietly.
 */
export { TRANSLATABLE_ATTRIBUTES } from 'langsys-js-typescript/pure';

/**
 * The fifteen attributes this package harvested before convergence.
 *
 * **Read-side only, and not a divergence.** Blocks registered before the twenty-seven
 * landed were keyed from these fifteen, so `derivations.ts` reproduces that shape to
 * find them. Nothing registers under it.
 *
 * Pinned as a literal rather than sliced from the twenty-seven. Slicing would track
 * upstream, and the whole point of this list is that it does NOT — it records what was
 * actually stored, which is a historical fact and cannot be re-derived from a list that
 * has since changed. See CID-3: tolerate historical ids on lookup, never emit them.
 */
export const HISTORICAL_TRANSLATABLE_ATTRIBUTES_15 = [
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
export { NON_TRANSLATABLE_ELEMENTS as SKIP_ELEMENTS } from 'langsys-js-typescript/pure';

/*
 * Consumed from the core rather than restated, for the same reason as the attribute
 * list: it decides identity, and a second copy fails as a silent re-key.
 *
 * `<noscript>` IS skipped, and this REVERSES what this file said until TOK-1 was
 * rewritten on 2026-09-12. The old reasoning was that noscript text is user-visible —
 * it renders whenever scripting is off — so excluding it would leave a real sentence
 * permanently untranslated. That premise is true and it is not enough:
 *
 *   - With scripting OFF, no browser SDK is running, so nothing client-side could ever
 *     have translated it. Only a server renderer could.
 *   - With scripting ON, which is the HTML spec's default, a parser treats a noscript
 *     body as RAW TEXT. Chromium and parse5 both yield the token
 *     `<p>Enable JavaScript</p>` — a markup string. Registering that ships markup to
 *     machine translation, which is the failure this family exists to prevent.
 *   - Implementations cannot be made to agree cheaply. `langsys-php` runs libxml2, which
 *     has NO scripting flag and parses noscript children as elements, so PHP derives
 *     `Enable JavaScript` where the JS family derives the markup string. Same content,
 *     two ids.
 *
 * Measured here, in headless Chromium 153 against the core's browser bundle: the JS
 * family agrees on `68a99f77615d438ede3cdb21710f7826`, the scripting-disabled parsers on
 * `e029887102428df850dbdef551c52eb4`. Excluding it makes every parser agree by
 * construction. The cost is that a noscript fallback stays in the base language, which
 * no client SDK could ever have translated anyway.
 *
 * `<template>` is skipped, but not for the reason the others are. In a DOM, template
 * content lives in a separate `DocumentFragment` on `HTMLTemplateElement.content`, so
 * `childNodes` is empty and the base SDK's walker finds nothing — it emits no tokens
 * without skipping anything. parse5 models this the same way, so this package ALREADY
 * agreed with the DOM path even with `skipCodeElements: false` — verified by execution.
 *
 * The entry stays anyway, because that agreement is an accident of two parsers happening
 * to model the spec identically. A forgiving parser (`htmlparser2`) treats `<template>`
 * as an ordinary element and would harvest its contents — a divergence in the opposite
 * direction from the one this list exists for, and one no fixture would think to pin
 * because both sides "obviously" agree today. Do not remove it as dead weight after
 * testing only in a browser.
 */

/** Catalog bucket for phrases registered with no category. */
export const UNCATEGORIZED = '__uncategorized__';
