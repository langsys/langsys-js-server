/**
 * Server-side `<Phrase>` — the rich-text half of 0.2.0.
 *
 * **`<Phrase>` and `<Translate>` key by opposite means.** `<Translate>` tokenizes: an
 * ordered array where arity IS identity and adjacent text nodes are never coalesced.
 * `<Phrase>` does the reverse — one coalesced, whitespace-collapsed string carrying
 * `{m0o}`/`{m0c}` slot markers, with no token array and no `custom_id` at all. A rule of
 * "never coalesce adjacent text nodes" is correct there and actively wrong here.
 *
 * **This file maps parse5 nodes onto the core's encoder; it does not reimplement it.**
 * `encodeRichText` in the core is DOM-bound (`childNodes`, `nodeType`, `cloneNode`), so it
 * cannot cross to `/pure` — but unlike the content-block path, the WALK is not the identity
 * here. Only the assembled string is. So the whole encoder travels as
 * `encodeRichPhrase`, and this supplies the node shape. One implementation of the key,
 * which is the property the `/pure` re-parent exists to preserve.
 */

import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { encodeRichPhrase } from 'langsys-js-typescript/pure';
import { SKIP_ELEMENTS } from './constants.js';

type P5Node = DefaultTreeAdapterMap['childNode'];
type P5Element = DefaultTreeAdapterMap['element'];

/**
 * The shape the core's encoder consumes. `payload` is opaque to it and handed straight
 * back in `slots`, in markup-token order.
 */
type RichTextNode<T> = { text: string } | { children: RichTextNode<T>[]; payload: T };

/** A `<Phrase>` key, plus the host nodes its slots correspond to. */
export interface EncodedPhrase {
    /** The identity. `{m0o}`/`{m0c}` markers, whitespace collapsed once over the whole. */
    phrase: string;
    /** The parse5 elements the markers stand for, **in the encoder's own index order**. */
    slots: P5Element[];
}

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const isText = (n: P5Node): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';
const isComment = (n: P5Node): boolean => n.nodeName === '#comment';

/**
 * Map a parse5 subtree onto the encoder's node shape.
 *
 * **Text values are passed through RAW — no trim, no collapse.** The collapse happens ONCE
 * over the assembled string, markup tokens included, inside the encoder. Trimming per node
 * looks equivalent and is not: `<p>a <em> b</em></p>` encodes as
 * `{m0o}a {m1o} b{m1c}{m0c}` with the space before `b` INSIDE the inner markers, while a
 * per-node trim yields `{m0o}a{m1o}b{m1c}{m0c}` — same nodes, same order, different key,
 * no error anywhere. It is the same mistake that split `custom_id` between the attribute
 * path and the text path, one primitive over.
 *
 * Comments map to empty text rather than being dropped. Measured by the core lane: `''`
 * is harmless because `'a' + '' + 'b'` is still `'ab'`, whereas contributing the comment's
 * DATA changes the string and giving it a SLOT shifts every later index.
 */
function toRichNodes(nodes: P5Node[]): RichTextNode<P5Element>[] {
    const out: RichTextNode<P5Element>[] = [];

    for (const node of nodes) {
        if (isText(node)) {
            out.push({ text: node.value });
            continue;
        }

        if (isComment(node)) {
            // Present, contributing nothing, consuming no slot index.
            out.push({ text: '' });
            continue;
        }

        if (!isElement(node)) continue;

        if ((SKIP_ELEMENTS as readonly string[]).includes(node.tagName.toLowerCase())) {
            // Same exclusion as the tokenizer (TOK-1): code and inert content are not
            // prose. Mapped to empty text rather than skipped outright, so the element
            // contributes nothing to the key WITHOUT shifting slot indices — dropping it
            // entirely would do the same here, but empty text says the intent.
            out.push({ text: '' });
            continue;
        }

        out.push({
            children: toRichNodes('childNodes' in node ? node.childNodes : []),
            payload: node,
        });
    }

    return out;
}

/**
 * Encode a `<Phrase>` host's inner HTML into its key.
 *
 * **The returned `slots` are the encoder's numbering, not ours.** Indices are pre-order,
 * parent before children, and a nested phrase is exactly where an adapter that numbered
 * its own slots would diverge — silently, because both sides produce well-formed markers
 * and only the key differs. Passing the node as an opaque payload and reading the order
 * back removes that failure mode rather than documenting it.
 */
export function encodePhrase(innerHtml: string): EncodedPhrase {
    const fragment = parseFragment(innerHtml, { scriptingEnabled: true });
    const { phrase, slots } = encodeRichPhrase(toRichNodes(fragment.childNodes));
    return { phrase, slots };
}
