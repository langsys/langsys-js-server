/**
 * String-based content-block tokenizer.
 *
 * This is the identity path. Its output feeds `generateCustomId`, so any divergence
 * from `langsys-js-typescript`'s DOM walker or `langsys-php`'s `HtmlParser` fragments
 * the shared catalog — and it fragments SILENTLY: a re-keyed block does not error, it
 * renders in the base language and re-registers, which is indistinguishable from a
 * phrase that was simply never translated.
 *
 * Mirrored from `langsys-js-typescript@0.6.5` `dist/index.mjs:1288-1338`
 * (`_walkForTokens` / `_tokenizeAttributes`). Where this file deviates, it says so and
 * says why. Divergence-by-tidying is the same failure class as divergence-by-oversight,
 * just better intentioned — so nothing here is "cleaned up".
 *
 * Parser: `parse5`, on the PHP owner's recommendation. `langsys-php` runs libxml, whose
 * HTML4 entity table decodes ~252 entities and leaves HTML5-only ones (`&NewLine;`,
 * `&Tab;`, semicolon-less `&nbsp`) literal. Reproducing that would mean building a
 * libxml emulator in Node and inheriting its defects. parse5 is spec-compliant, so the
 * divergences from PHP become enumerable rather than emergent — and accidental
 * agreement (which `htmlparser2`'s forgiving parsing would produce on some inputs) is
 * indistinguishable from designed agreement until the input that separates them.
 */

import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import {
    PHRASE_MARKER_ATTRS,
    SKIP_ELEMENTS,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from './constants.js';
import { normalizeMarkupPlaceholders, normalizeTokenText } from 'langsys-js-typescript/pure';

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

export interface TokenizeOptions {
    /**
     * Harvest `<select>` option text a second time via `querySelectorAll`.
     *
     * The base SDK's `legacyTokenizeElement` sets this. It exists because `<select>`
     * option text was harvested twice before 0.6.3 — once by the recursive descent and
     * once by an explicit sweep. **Never set this for registration**; it is for reading
     * pre-0.6.3 catalog entries only.
     */
    duplicateSelectOptions?: boolean;

    /**
     * Skip `<script>`/`<style>`/`<template>` subtrees. NOT `<noscript>`, whose text is
     * user-visible whenever scripting is off — see `SKIP_ELEMENTS`.
     *
     * Defaults to `true`, which is a knowing divergence from both siblings — see
     * `SKIP_ELEMENTS`. Set `false` to reproduce their output for a fallback read.
     */
    skipCodeElements?: boolean;

    /**
     * The attribute list to harvest. Defaults to this package's active 15.
     *
     * Exposed for `derivations.ts` to compute fallback ids under a different list. It
     * is deliberately NOT reachable from any public, user-facing API: `custom_id` must
     * be a function of content, never of host configuration.
     */
    translatableAttributes?: readonly string[];
}

function isElement(node: Node): node is Element {
    return 'tagName' in node && typeof (node as Element).tagName === 'string';
}

function isTextNode(node: Node): node is TextNode {
    return node.nodeName === '#text';
}

function hasChildNodes(node: Node): node is ParentNode {
    const children = (node as ParentNode).childNodes;
    return Array.isArray(children) && children.length > 0;
}

function getAttribute(element: Element, name: string): string | null {
    // parse5 lowercases attribute names during parsing, and on a duplicate attribute
    // it keeps the FIRST — both matching HTML5 and, as the PHP owner measured, libxml.
    const attr = element.attrs.find((a) => a.name === name);
    return attr ? attr.value : null;
}

function hasAttribute(element: Element, name: string): boolean {
    return element.attrs.some((a) => a.name === name);
}

/**
 * `translate="no"` / `data-notrans`, mirrored byte-for-byte from
 * `langsys-js-typescript` `dist/index.mjs:1158-1163` and `langsys-php`'s method of the
 * same name.
 *
 * Presence means intent, like any boolean HTML attribute — but an explicit `="false"`
 * or `="0"` opts OUT of the opt-out, compared after trimming.
 */
export function isTranslationExcluded(element: Element): boolean {
    if ((getAttribute(element, 'translate') ?? '').toLowerCase() === 'no') return true;
    if (!hasAttribute(element, 'data-notrans')) return false;
    const value = (getAttribute(element, 'data-notrans') ?? '').trim().toLowerCase();
    return value !== 'false' && value !== '0';
}

/**
 * Whether a subtree is a self-managed keep-together phrase.
 *
 * Accepts BOTH spellings, matching the base SDK. Note that `langsys-php` defines an
 * identical predicate and **never calls it from its tokenizer** — mirrored predicates
 * are not a symmetric contract, and only call sites affect identity.
 */
export function isPhraseMarked(element: Element): boolean {
    return PHRASE_MARKER_ATTRS.some((attr) => {
        if (!hasAttribute(element, attr)) return false;
        const value = (getAttribute(element, attr) ?? '').trim().toLowerCase();
        return value !== 'false' && value !== '0';
    });
}

/**
 * Harvest translatable attribute values from one element.
 *
 * Order is identity. Two properties this must preserve, both verified in the base SDK
 * and both matching PHP:
 *
 *  1. It iterates the CONSTANT and pulls each value by name — it never enumerates the
 *     element's own attributes. So `<img title alt>` and `<img alt title>` produce
 *     identical tokens. An implementation that walks `element.attrs` would let an
 *     author re-key a block by reordering two attributes: the least suspicious edit
 *     that exists.
 *  2. `value` is emitted AFTER the whole constant loop — then `<button>`, then
 *     `<input type=submit|button>`.
 */
/**
 * An attribute value canonicalised the same way a text node is (TOK-4).
 *
 * `trim()` alone was the bug this replaces. A multiline `alt` produced a DIFFERENT id
 * from the identical sentence in a `<p>`, because text nodes collapsed their internal
 * runs and attributes did not — so the same words registered twice depending on where
 * the author happened to wrap the line. Invisible in rendered output, and invisible in
 * any fixture whose attribute values are single-line, which is all of the obvious ones.
 *
 * `normalizeTokenText` comes from the core, so this cannot drift from the client SDK we
 * hydrate over: it is the same function, not the same intent.
 */
function normalizedAttribute(element: Element, attr: string): string | undefined {
    const raw = getAttribute(element, attr);
    return raw === undefined || raw === null ? undefined : normalizeTokenText(raw);
}

function tokenizeAttributes(
    element: Element,
    tokens: string[],
    duplicateSelectOptions: boolean,
    translatableAttributes: readonly string[],
): void {
    const tagName = element.tagName.toLowerCase();

    // NOTE: the base SDK absolutizes `img.src` here (`dist/index.mjs:1312-1315`).
    // That is a `content`-snapshot concern only — `src` is not translatable, so it
    // cannot reach `tokens[]`. With no DOM there is no base URL to resolve against,
    // so it is intentionally not reproduced. See `content` caveats in the README.

    for (const attr of translatableAttributes) {
        const value = normalizedAttribute(element, attr);
        if (value) tokens.push(normalizeMarkupPlaceholders(value));
    }

    if ((VALUE_TRANSLATABLE_ELEMENTS as readonly string[]).includes(tagName)) {
        const value = normalizedAttribute(element, 'value');
        if (value) tokens.push(normalizeMarkupPlaceholders(value));
    }

    if (tagName === 'input') {
        const inputType = getAttribute(element, 'type')?.toLowerCase();
        if (inputType && (VALUE_TRANSLATABLE_INPUT_TYPES as readonly string[]).includes(inputType)) {
            const value = normalizedAttribute(element, 'value');
            if (value) tokens.push(normalizeMarkupPlaceholders(value));
        }
    }

    if (duplicateSelectOptions && tagName === 'select') {
        for (const optionText of collectOptionText(element)) {
            tokens.push(normalizeMarkupPlaceholders(optionText));
        }
    }
}

/** `select.querySelectorAll('option')` + `textContent.trim()`, without a DOM. */
function collectOptionText(select: Element): string[] {
    const out: string[] = [];
    const visit = (node: Node): void => {
        if (isElement(node) && node.tagName.toLowerCase() === 'option') {
            const text = normalizeTokenText(textContentOf(node));
            if (text) out.push(text);
        }
        if (hasChildNodes(node)) for (const child of node.childNodes) visit(child);
    };
    if (hasChildNodes(select)) for (const child of select.childNodes) visit(child);
    return out;
}

function textContentOf(node: Node): string {
    if (isTextNode(node)) return node.value;
    if (!hasChildNodes(node)) return '';
    return node.childNodes.map(textContentOf).join('');
}

/**
 * The walk. Mirrors `_walkForTokens` statement for statement.
 *
 * Order within the loop is load-bearing and is NOT rearranged:
 *   exclusion -> phrase marker -> attributes -> text -> recurse.
 *
 * Two consequences that are easy to get wrong and silent when wrong:
 *  - An excluded or phrase-marked element loses its ATTRIBUTES too. The check returns
 *    before `tokenizeAttributes`, so `translate="no"` on an `<img alt="...">` drops the
 *    `alt` as well as the subtree. Implementing this as "skip children" is wrong only
 *    on attribute-bearing nodes, which is exactly when nobody is looking.
 *  - Attributes precede children, depth-first in document order. A walker that emits
 *    attributes after text is conformant-looking and fragments every catalog
 *    containing an `alt` or a `placeholder`.
 */
function walkForTokens(
    nodes: readonly Node[],
    tokens: string[],
    duplicateSelectOptions: boolean,
    skipCodeElements: boolean,
    translatableAttributes: readonly string[],
): void {
    for (const node of nodes) {
        if (isElement(node)) {
            if (isTranslationExcluded(node)) continue;
            if (isPhraseMarked(node)) continue;
            // Divergence from both siblings, deliberate — see SKIP_ELEMENTS.
            if (skipCodeElements && (SKIP_ELEMENTS as readonly string[]).includes(node.tagName.toLowerCase())) {
                continue;
            }
            tokenizeAttributes(node, tokens, duplicateSelectOptions, translatableAttributes);
        }

        if (isTextNode(node)) {
            // JS `\s` matches U+00A0, so `&nbsp;` collapses here. `langsys-php`'s
            // `normalizeWhitespace()` uses PCRE `\s` with no `/u` modifier, which is
            // ASCII-only, and its `trim()` default charlist excludes U+00A0 — so PHP
            // RETAINS it. `<p>&nbsp;</p>` is one token there and zero here.
            //
            // That divergence is real, known, and NOT resolved by this package: it is a
            // product decision (SPEC.md open question #10) that changes the token COUNT,
            // and whichever way it goes it orphans existing catalog entries. This
            // package matches the JS client family, which is the partner it hydrates
            // over on every request.
            const contentToken = node.value.replace(/\s+/g, ' ').trim();
            if (contentToken) tokens.push(normalizeMarkupPlaceholders(contentToken));
            continue;
        }

        // Comment nodes, doctypes and CDATA fall through to here and are dropped —
        // they are neither elements nor text, and have no child nodes.
        if (!hasChildNodes(node)) continue;
        walkForTokens(node.childNodes, tokens, duplicateSelectOptions, skipCodeElements, translatableAttributes);
    }
}

/**
 * Tokenize a block's **inner** HTML.
 *
 * Takes the children of a notional root, matching both siblings: the base SDK calls
 * `_walkForTokens(root, clone.childNodes, ...)` and PHP's `extractAsContentBlock()`
 * hands inner HTML to `extractPhrases()`. **The root element's own attributes are not
 * harvested and its own markers are not honoured** — passing `outerHTML` here would
 * silently produce a different id.
 */
export function tokenizeHtml(innerHtml: string, options: TokenizeOptions = {}): string[] {
    const {
        duplicateSelectOptions = false,
        skipCodeElements = true,
        translatableAttributes = TRANSLATABLE_ATTRIBUTES,
    } = options;

    // `scriptingEnabled: true` is parse5's default. Stated explicitly as a declaration of
    // intent, NOT as a guard that anything currently checks.
    //
    // **It is unobservable on this tree, and saying so is the point.** While `<noscript>`
    // was harvested the flag decided its id: scripting on yields one raw-text token
    // (`<p>Enable JavaScript</p>`, measured in headless Chromium 153 and matched by
    // parse5), scripting off yields parsed elements. TOK-1 now excludes `<noscript>`
    // entirely, so both parse modes produce identical tokens and flipping this line turns
    // NOTHING red — verified, 392 passed either way. There is no test here that can fail
    // on it, and this comment previously claimed otherwise.
    //
    // Kept anyway, for one reason that is not a guard: it records which parser mode this
    // package's identity was established under, so a future raw-text context (or a
    // reversal of the noscript exclusion) starts from a stated position rather than from
    // whatever parse5 defaults to that year. If it ever becomes observable again, it
    // needs a test at that point — the explicit argument is not a substitute for one.
    const fragment = parseFragment(innerHtml, { scriptingEnabled: true });
    const tokens: string[] = [];
    walkForTokens(fragment.childNodes, tokens, duplicateSelectOptions, skipCodeElements, translatableAttributes);
    return tokens;
}
