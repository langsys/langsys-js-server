/**
 * Server-side `<Translate>` — the string→string half of 0.2.0.
 *
 * **This layer is synchronous and knows nothing about any framework.** It takes the inner
 * HTML of a block, resolves it against the request's catalog, and returns the translated
 * HTML plus the id it resolved under. Adapters own the children→string step, which is the
 * part that genuinely differs per framework (Svelte re-enters `render()`, Vue needs an
 * async `setup()`, React walks the element tree as data). Keeping the core synchronous is
 * what stops Vue's asynchrony infecting the model, and what makes one framework's
 * mechanism failing cost an adapter rather than everything.
 *
 * **`<Translate>` and `<Phrase>` key by opposite means and must not be conflated.** This
 * file is `<Translate>`: tokenize → `tokens[]` → `generateCustomId`, adjacent text nodes
 * **not** coalesced, arity *is* identity. `<Phrase>` coalesces into a single
 * whitespace-collapsed string with `{m0o}`/`{m0c}` slot markers and has no `custom_id` at
 * all — a rule of "never coalesce adjacent text nodes" is correct here and actively wrong
 * there. `<Phrase>` is not implemented yet: it needs `encodeRichText`, which the core
 * exports from its main entry but not from `/pure`, and importing the main entry pulls in
 * the singleton graph this package exists to avoid.
 */

import { parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { generateCustomId } from 'langsys-js-typescript/pure';
import { deriveBlockIdentity } from './derivations.js';
import { tokenizeHtml } from './tokenizer.js';
import { getScope } from './context.js';
import { queueMiss } from './harvest.js';
import { CONTENT_BLOCK_MARKER_EMIT, SKIP_ELEMENTS, UNCATEGORIZED } from './constants.js';
import type { MissingPhrase } from './types.js';

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];

/** The result of rendering one content block server-side. */
export interface RenderedBlock {
    /** The block's inner HTML, translated where the catalog had an answer. */
    html: string;
    /** The id this block resolved under. Stamp it on the host — see MARK-1. */
    customId: string;
    /** Phrases this block could not resolve. Empty when the block was fully translated. */
    missing: MissingPhrase[];
    /** True when the catalog knew this block at all. */
    known: boolean;
}

/**
 * Thrown when an adapter hands over children it could not turn into HTML.
 *
 * **Named, and thrown rather than swallowed, deliberately** — this is the one place this
 * package prefers an exception to degradation, and the reason is that the alternative is
 * silent mis-keying. Under React's `react-server` condition a Client Component with Server
 * Component children does not fail: capture returns the **Suspense fallback**, which is
 * real HTML, tokenizes cleanly, and produces a confident `custom_id` for content nobody
 * wrote. That block then registers under the wrong id, and every later render disagrees
 * with it. A thrown error costs a visible 500 in development; the fallback costs a
 * permanently split catalog entry that nothing reports.
 *
 * WIRE-4 is not in tension with this. WIRE-4 governs the TRANSLATION call — a failure to
 * reach the API must never become a 500. This is a caller handing us content that does not
 * exist, which is a programming error in the integration, not a transient condition.
 */
export class UncapturableChildError extends Error {
    override readonly name = 'UncapturableChildError';
    constructor(detail: string) {
        super(
            `<Translate> could not capture its children: ${detail}. This is refused rather ` +
                'than guessed, because the usual failure is silent: React returns a Suspense ' +
                'fallback for an uncapturable child, which tokenizes cleanly and mis-keys the ' +
                'block under an id nobody wrote. Scope <Translate> to leaf content — a ' +
                'component inside the slot cannot read context across the nested render ' +
                'either, so it would silently get its fallback too.',
        );
    }
}

const isElement = (n: Node): n is Element => 'tagName' in n;
const isText = (n: Node): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';
const hasChildren = (n: Node): n is Element => 'childNodes' in n;

/**
 * Replace each token's text in place, in the same depth-first order the tokenizer walks.
 *
 * Order is the whole contract. `tokenizeHtml` produces the token array that `custom_id`
 * hashes, so walking a second time in the same order and consuming translations
 * positionally keeps substitution aligned with identity by construction. Matching on text
 * VALUE instead would put the same word in two places out of step the moment one of them
 * is translated differently.
 */
function substitute(nodes: Node[], next: () => string | undefined): void {
    for (const node of nodes) {
        if (isElement(node)) {
            const tag = node.tagName.toLowerCase();
            if ((SKIP_ELEMENTS as readonly string[]).includes(tag)) continue;
        }

        if (isText(node)) {
            // A whitespace-only node produced no token, so it consumes none.
            if (node.value.replace(/\s+/g, ' ').trim()) {
                const replacement = next();
                if (replacement !== undefined) {
                    // Preserve the node's OWN leading and trailing whitespace and replace
                    // only the part that became a token. The token is trimmed — that is
                    // what identity hashes — but the node is not, and the space between
                    // `Based on ` and `<strong>` is real rendered output. Replacing the
                    // whole value collapses `Basato su <strong>5</strong>` into
                    // `Basato su<strong>5</strong>`, which is invisible in a diff of the
                    // tokens and obvious on the page.
                    const [, lead = '', , trail = ''] = node.value.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
                    node.value = lead + replacement + trail;
                }
            }
            continue;
        }

        if (hasChildren(node)) substitute(node.childNodes, next);
    }
}

/**
 * Resolve one `<Translate>` block against the current request's catalog.
 *
 * Returns the translated inner HTML and the id it resolved under. The caller stamps that
 * id on the host element — see `stampContentBlock`.
 */
export function renderTranslateBlock(innerHtml: string, category = ''): RenderedBlock {
    const scope = getScope();
    const tokens = tokenizeHtml(innerHtml);
    const identity = deriveBlockIdentity(innerHtml, category);
    const missing: MissingPhrase[] = [];

    if (!scope) {
        // Same posture as `t()`: never throw for a missing scope, because the correct
        // degraded output is the source content and a 500 is strictly worse.
        return { html: innerHtml, customId: identity.primary.id, missing, known: false };
    }

    const bucket = scope.catalog[category || UNCATEGORIZED];

    // CAT-1/CAT-3: presence, not truthiness, and own-property not `in`. A block that is
    // registered but untranslated arrives as an object whose inner phrases are null; that
    // is KNOWN, and re-registering it is the write storm CAT-3 names.
    const lookup = (id: string): Record<string, unknown> | undefined => {
        if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, id)) return undefined;
        const value = (bucket as Record<string, unknown>)[id];
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
    };

    // CID-3: read under the historical derivations too, so a block registered by an older
    // shape still resolves. Registration always uses the primary.
    let block = lookup(identity.primary.id);
    let known = block !== undefined || (bucket !== undefined && Object.prototype.hasOwnProperty.call(bucket, identity.primary.id));
    if (block === undefined) {
        for (const fallback of identity.fallbacks) {
            const found = lookup(fallback.id);
            if (found) {
                block = found;
                known = true;
                break;
            }
        }
    }

    if (!known && scope.catalogAvailable && scope.locale !== scope.baseLocale) {
        // WIRE-4 clause 2 applies here exactly as it does to `t()`: with no catalog a miss
        // is indistinguishable from a hit, and registering turns an outage into a storm.
        for (const token of tokens) queueMiss(scope, token, category);
        missing.push(...tokens.map((phrase) => ({ phrase, category })));
    }

    if (!block) return { html: innerHtml, customId: identity.primary.id, missing, known };

    const fragment = parseFragment(innerHtml, { scriptingEnabled: true });
    let i = 0;
    substitute(fragment.childNodes, () => {
        const source = tokens[i++];
        if (source === undefined) return undefined;
        const translated = block![source];
        // CAT-2: the value decides display. `null` (registered, translation running) and
        // `''` both fall back to source text rather than blanking the copy.
        return typeof translated === 'string' && translated.length > 0 ? translated : undefined;
    });

    return { html: serialize(fragment), customId: identity.primary.id, missing, known };
}

/**
 * Stamp a resolved id onto a host element's attribute list (MARK-1).
 *
 * Returns the attribute name/value pair rather than mutating HTML, because every adapter
 * has its own way of spreading attributes onto a host and string-splicing one in is how a
 * marker ends up inside a quoted value.
 *
 * `data-ls-contentblock` is the emitted spelling; both spellings are accepted on read
 * (MARK-2), which is what lets a PHP page host a JS-rendered component without either
 * reader re-splitting the other's blocks.
 */
export function stampContentBlock(customId: string): Record<string, string> {
    return { [CONTENT_BLOCK_MARKER_EMIT]: customId };
}

/** The id a block WOULD resolve under, without touching the catalog or the miss queue. */
export function blockId(innerHtml: string, category = ''): string {
    return generateCustomId(category, tokenizeHtml(innerHtml));
}
