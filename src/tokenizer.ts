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
    CONTENT_BLOCK_MARKER_ATTRS,
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
 * Whether an element is a content-block host: a `data-ls-contentblock` or
 * `data-langsys-contentblock` marker with any value but `false` or `0`, trimmed and compared
 * case-insensitively (MARK-3). A stamped id and a bare or truthy declaration both count.
 * Mirrors the core's `isContentBlockMarked`.
 */
export function isContentBlockMarked(element: Element): boolean {
    return (CONTENT_BLOCK_MARKER_ATTRS as readonly string[]).some((attr) => {
        if (!hasAttribute(element, attr)) return false;
        const value = (getAttribute(element, attr) ?? '').trim().toLowerCase();
        return value !== 'false' && value !== '0';
    });
}

/**
 * Whether a parsed unit has exactly one non-whitespace text node (TOK-6).
 *
 * Mirrors the core `Translate`'s `findSingleTextNode`, which is TOK's reference: every text node
 * in the unit counts, including inside excluded, code and phrase-marked subtrees, except inside
 * an excised content-block host (MARK-4).
 */
export function hasSingleTextNode(nodes: readonly Node[]): boolean {
    let found = 0;
    const walk = (children: readonly Node[]): boolean => {
        for (const child of children) {
            if (isTextNode(child)) {
                if (normalizeTokenText(child.value) && ++found > 1) return false;
            } else if (isElement(child) && isContentBlockMarked(child)) {
                continue;
            } else if (hasChildNodes(child) && !walk(child.childNodes)) {
                return false;
            }
        }
        return true;
    };
    return walk(nodes) && found === 1;
}

/**
 * A token, together with the place in the tree it was read from.
 *
 * **This is what makes registration and substitution unable to drift.** They used to walk
 * the tree separately: the tokenizer built the token array that identity hashes, and the
 * `<Translate>` applier re-walked and consumed that array POSITIONALLY. The two walks
 * disagreed. The tokenizer skips translation-excluded and phrase-marked subtrees and
 * emits attribute and value tokens before an element's text; the applier mirrored only
 * the code-element skip. So a block containing an image shifted every later text node
 * onto the translation meant for the token before it, a phrase-marked span was
 * overwritten, and attribute translations never rendered. Found by the TS lane's
 * attribute probe, and silent in the way that matters: every output was plausible
 * translated text in the wrong place.
 *
 * Now there is one walk. It yields each token with an `apply` bound to that token's exact
 * location, so the applier never counts, and a translation cannot land anywhere but where
 * its token came from — on every branch, including branches added later.
 */
export interface TokenSlot {
    readonly token: string;
    /**
     * Where the token was read from. TOK-6 needs it: a unit is a phrase only when its one
     * token is a `text` node; a single `attribute` token has no text node to render into.
     */
    readonly kind: 'text' | 'attribute' | 'option';
    /** Write a translation back to exactly where `token` was read from. */
    apply(translated: string): void;
}

/**
 * An attribute value canonicalised the same way a text node is (TOK-4).
 *
 * `trim()` alone was the bug this replaces. A multiline `alt` produced a DIFFERENT id
 * from the identical sentence in a `<p>`, because text nodes collapsed their internal
 * runs and attributes did not — so the same words registered twice depending on where
 * the author happened to wrap the line.
 *
 * `normalizeTokenText` comes from the core, so this cannot drift from the client SDK we
 * hydrate over: it is the same function, not the same intent.
 */
function normalizedAttribute(element: Element, attr: string): string | undefined {
    const raw = getAttribute(element, attr);
    return raw === undefined || raw === null ? undefined : normalizeTokenText(raw);
}

function setAttribute(element: Element, name: string, value: string): void {
    // Mirrors `getAttribute`: on a duplicate attribute parse5 keeps the FIRST, which is the
    // one the token was read from, so it is the one the translation replaces.
    const attr = element.attrs.find((a) => a.name === name);
    if (attr) attr.value = value;
}

function attributeSlot(element: Element, name: string, value: string): TokenSlot {
    return { token: normalizeMarkupPlaceholders(value), kind: 'attribute', apply: (t) => setAttribute(element, name, t) };
}

/**
 * Harvest translatable attribute values from one element, as slots.
 *
 * Order is identity. Two properties this must preserve, both verified in the base SDK
 * and both matching PHP:
 *
 *  1. It iterates the CONSTANT and pulls each value by name — it never enumerates the
 *     element's own attributes. So `<img title alt>` and `<img alt title>` produce
 *     identical tokens. The slot still writes back to the attribute by NAME, so where a
 *     translation lands is decided by location, not by the author's attribute order.
 *  2. `value` is emitted AFTER the whole constant loop — then `<button>`, then
 *     `<input type=submit|button>`.
 */
function tokenizeAttributes(
    element: Element,
    slots: TokenSlot[],
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
        if (value) slots.push(attributeSlot(element, attr, value));
    }

    if ((VALUE_TRANSLATABLE_ELEMENTS as readonly string[]).includes(tagName)) {
        const value = normalizedAttribute(element, 'value');
        if (value) slots.push(attributeSlot(element, 'value', value));
    }

    if (tagName === 'input') {
        const inputType = getAttribute(element, 'type')?.toLowerCase();
        if (inputType && (VALUE_TRANSLATABLE_INPUT_TYPES as readonly string[]).includes(inputType)) {
            const value = normalizedAttribute(element, 'value');
            if (value) slots.push(attributeSlot(element, 'value', value));
        }
    }

    if (duplicateSelectOptions && tagName === 'select') {
        for (const optionText of collectOptionText(element)) {
            // Reproduces pre-0.6.3 token ARITY for reading old ids, and nothing more. The
            // apply is deliberately a no-op: each option's own text node yields its own
            // slot during recursion and renders it there, so writing here as well would
            // render the option twice.
            slots.push({ token: normalizeMarkupPlaceholders(optionText), kind: 'option', apply: () => {} });
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
 * The walk. Mirrors `_walkForTokens` statement for statement, yielding slots.
 *
 * Order within the loop is load-bearing and is NOT rearranged:
 *   exclusion -> phrase marker -> attributes -> text -> recurse.
 *
 * Two consequences that are easy to get wrong and silent when wrong:
 *  - An excluded or phrase-marked element loses its ATTRIBUTES too. The check returns
 *    before `tokenizeAttributes`, so `translate="no"` on an `<img alt="...">` drops the
 *    `alt` as well as the subtree — and because the applier only ever writes through
 *    slots, it leaves that `alt` untouched too.
 *  - Attributes precede children, depth-first in document order. A walker that emits
 *    attributes after text is conformant-looking and fragments every catalog
 *    containing an `alt` or a `placeholder`.
 */
function walkSlots(
    nodes: readonly Node[],
    slots: TokenSlot[],
    duplicateSelectOptions: boolean,
    skipCodeElements: boolean,
    translatableAttributes: readonly string[],
): void {
    for (const node of nodes) {
        if (isElement(node)) {
            if (isTranslationExcluded(node)) continue;
            if (isPhraseMarked(node)) continue;
            // A nested content-block host is a unit of its own (MARK-4), whether stamped with an
            // id or declared by a bare or truthy marker (MARK-3), so it contributes no tokens here
            // and yields no slot — the enclosing render never writes into it.
            if (isContentBlockMarked(node)) continue;
            // Divergence from both siblings, deliberate — see SKIP_ELEMENTS.
            if (skipCodeElements && (SKIP_ELEMENTS as readonly string[]).includes(node.tagName.toLowerCase())) {
                continue;
            }
            tokenizeAttributes(node, slots, duplicateSelectOptions, translatableAttributes);
        }

        if (isTextNode(node)) {
            // The core's own canonicalization: strip the 28 C0 controls, collapse the JS `\s`
            // set (U+00A0 included), trim — in that order (TOK-2). One function for text nodes
            // and attributes, so the two paths cannot canonicalise the same words differently.
            const contentToken = normalizeTokenText(node.value);
            if (contentToken) {
                const text = node;
                slots.push({
                    token: normalizeMarkupPlaceholders(contentToken),
                    kind: 'text',
                    apply: (translated) => {
                        // Preserve the node's OWN leading and trailing whitespace and replace
                        // only the part that became a token. The token is trimmed — that is
                        // what identity hashes — but the node is not, and the space between
                        // `Based on ` and `<strong>` is real rendered output.
                        const m = text.value.match(/^(\s*)([\s\S]*?)(\s*)$/);
                        text.value = (m?.[1] ?? '') + translated + (m?.[3] ?? '');
                    },
                });
            }
            continue;
        }

        // Comment nodes, doctypes and CDATA fall through to here and are dropped —
        // they are neither elements nor text, and have no child nodes.
        if (!hasChildNodes(node)) continue;
        walkSlots(node.childNodes, slots, duplicateSelectOptions, skipCodeElements, translatableAttributes);
    }
}

/**
 * Parse a block's inner HTML once and walk it once, returning the parsed fragment together
 * with a slot for every token. The applier writes translations through the slots and then
 * serialises THIS fragment, so registration and substitution are the same walk over the
 * same tree.
 */
export function collectSlots(
    innerHtml: string,
    options: TokenizeOptions = {},
): { fragment: DefaultTreeAdapterMap['documentFragment']; slots: TokenSlot[] } {
    const {
        duplicateSelectOptions = false,
        skipCodeElements = true,
        translatableAttributes = TRANSLATABLE_ATTRIBUTES,
    } = options;

    // `scriptingEnabled: true` is parse5's default, stated as a declaration of intent and
    // NOT as a guard anything checks: with `<noscript>` excluded by TOK-1, both parse modes
    // produce identical tokens and flipping this turns nothing red. It records which parser
    // mode identity was established under; if it ever becomes observable, it needs a test.
    const fragment = parseFragment(innerHtml, { scriptingEnabled: true });
    const slots: TokenSlot[] = [];
    walkSlots(fragment.childNodes, slots, duplicateSelectOptions, skipCodeElements, translatableAttributes);
    return { fragment, slots };
}

/**
 * Tokenize a block's **inner** HTML.
 *
 * Takes the children of a notional root, matching both siblings: the base SDK calls
 * `_walkForTokens(root, clone.childNodes, ...)` and PHP's `extractAsContentBlock()`
 * hands inner HTML to `extractPhrases()`. **The root element's own attributes are not
 * harvested and its own markers are not honoured** — passing `outerHTML` here would
 * silently produce a different id.
 *
 * The tokens are exactly the slots' tokens, so identity and substitution cannot disagree.
 */
export function tokenizeHtml(innerHtml: string, options: TokenizeOptions = {}): string[] {
    return collectSlots(innerHtml, options).slots.map((slot) => slot.token);
}
