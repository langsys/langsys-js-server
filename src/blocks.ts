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

import { serialize } from 'parse5';
import { generateCustomId, interpolate, isICU, normalizeMarkupPlaceholders } from 'langsys-js-typescript/pure';
import { deriveBlockIdentity } from './derivations.js';
import { collectSlots, hasSingleTextNode, tokenizeHtml, type TokenSlot } from './tokenizer.js';
import { interpolationNotices } from './translator.js';
import type { Logger } from './logger.js';
import { getScope } from './context.js';
import { queueBlock, queueMiss } from './harvest.js';
import { CONTENT_BLOCK_MARKER_EMIT, UNCATEGORIZED } from './constants.js';
import type { MissingPhrase } from './types.js';

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
    /**
     * The attribute the host element carries (MARK-1): `data-ls-contentblock` with the id this
     * render resolved under — the primary id, or the historical one a fallback resolved to.
     * This package renders a host's inner HTML, not the host; the caller spreads these onto it.
     */
    hostAttributes: Record<string, string>;
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

/**
 * Write each slot's rendering back, ICU included (ICU-1).
 *
 * The client core's `<Translate>` renders a token carrying ICU with no params — its `other`
 * branch, `#` as `{argName}` — at the base locale, on a catalog hit and on the fallback alike
 * (`langsys-js-typescript` `ff57476`). A server block returning the raw source would disagree
 * with the first client render on every such block.
 *
 * Two properties are deliberate. Only text `isICU` recognises reaches `interpolate`, so prose is
 * never reformatted. And a slot is written only when there is something to write — a
 * translation, or ICU that rendered differently — because a token is whitespace-collapsed and
 * its node is not: writing an unchanged token back would silently rewrite `Hello   there`.
 */
function renderSlots(
    slots: readonly TokenSlot[],
    block: Record<string, unknown> | undefined,
    locale: string | undefined,
    logger?: Logger,
): void {
    for (const slot of slots) {
        const translated = block?.[slot.token];
        // CAT-2: the value decides display. `null` (registered, translation running) and
        // `''` both fall back to the source token rather than blanking the copy.
        const hit = typeof translated === 'string' && translated.length > 0;
        const raw = hit ? (translated as string) : slot.token;
        const text = isICU(raw) ? interpolate(raw, {}, locale, logger ? interpolationNotices(logger) : undefined) : raw;
        if (hit || text !== slot.token) slot.apply(text);
    }
}

/** The same phrases, as sets (CID-4). */
function sameContent(stored: readonly string[], tokens: readonly string[]): boolean {
    const a = new Set(stored);
    const b = new Set(tokens);
    return a.size === b.size && [...a].every((phrase) => b.has(phrase));
}

/**
 * Resolve one `<Translate>` block against the current request's catalog.
 *
 * Returns the translated inner HTML and the id it resolved under. The caller stamps that
 * id on the host element — see `stampContentBlock`.
 */
export function renderTranslateBlock(innerHtml: string, category = ''): RenderedBlock {
    const scope = getScope();
    // ONE parse and ONE walk, shared by registration and substitution — see `TokenSlot`.
    const { fragment, slots } = collectSlots(innerHtml);
    const tokens = slots.map((slot) => slot.token);
    const identity = deriveBlockIdentity(innerHtml, category);
    const missing: MissingPhrase[] = [];

    // Only a block carrying ICU needs a pass without a catalog answer; anything else is
    // returned exactly as written, byte for byte.
    const carriesIcu = tokens.some((token) => isICU(token));

    if (!scope) {
        // Same posture as `t()`: never throw for a missing scope, because the correct
        // degraded output is the source content and a 500 is strictly worse. ICU still
        // renders, as it does from `t()` out of scope.
        if (!carriesIcu) return { html: innerHtml, customId: identity.primary.id, missing, known: false, hostAttributes: stampContentBlock(identity.primary.id) };
        renderSlots(slots, undefined, undefined);
        return { html: serialize(fragment), customId: identity.primary.id, missing, known: false, hostAttributes: stampContentBlock(identity.primary.id) };
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
    let resolvedId = identity.primary.id;
    if (block === undefined) {
        for (const fallback of identity.fallbacks) {
            const found = lookup(fallback.id);
            // CID-4: a historical id is attached only when the stored block holds this block's
            // phrases. None of the historical id spaces is injective, so a collision would
            // otherwise render a foreign block's text and never register this one. Compared as a
            // set: the catalog keys a block by phrase, so its order is already gone.
            if (found && sameContent(Object.keys(found), tokens)) {
                block = found;
                known = true;
                resolvedId = fallback.id;
                break;
            }
        }
    }

    // TOK-6: the unit is a PHRASE when its one token is its one text node, and a content block
    // otherwise — the core `Translate`'s routing. Shape is identity: the same words as a phrase
    // and as a block are two catalog entries.
    const phraseShaped = tokens.length === 1 && slots[0]!.kind === 'text' && hasSingleTextNode(fragment.childNodes);

    // What the slots render from. A block entry wins when present — the token may be stored
    // as a block, registered under this id by another SDK or an older shape — and a phrase
    // falls back to the flat catalog, exactly as `t()` reads it.
    let entries = block;
    if (phraseShaped && !block) {
        const token = tokens[0]!;
        if (bucket !== undefined && Object.prototype.hasOwnProperty.call(bucket, token)) {
            known = true;
            entries = { [token]: (bucket as Record<string, unknown>)[token] };
        }
    }

    // WIRE-4 clause 2: with no catalog a miss is indistinguishable from a hit, and registering
    // turns an outage into a storm. A base-locale miss is not a miss.
    if (!known && scope.catalogAvailable && scope.locale !== scope.baseLocale) {
        if (phraseShaped) {
            queueMiss(scope, tokens[0]!, category);
        } else {
            // ONE item under the block's id, carrying its tokens in order — the shape the
            // core's `registerContentBlock` sends and the block lookup above reads back.
            // `content` is the markup snapshot a translator sees; a server sees the host's
            // inner HTML only, so that is what it carries.
            queueBlock(scope, {
                type: 'content_block',
                custom_id: identity.primary.id,
                category,
                content: normalizeMarkupPlaceholders(innerHtml),
                phrases: tokens.map((phrase) => ({ phrase })),
            });
        }
        // Deduplicated here, NOT in `tokens`. Arity is identity, so a repeated phrase stays in
        // the token array four times; the returned record lists the phrases this unit could
        // not resolve.
        missing.push(...[...new Set(tokens)].map((phrase) => ({ phrase, category })));
    }

    if (!entries) {
        // A miss, or the base locale. Rendered only when there is ICU to render (ICU-1); the
        // client core skips this pass for the same units.
        if (!carriesIcu) return { html: innerHtml, customId: identity.primary.id, missing, known, hostAttributes: stampContentBlock(resolvedId) };
        renderSlots(slots, undefined, scope.locale, scope.logger);
        return { html: serialize(fragment), customId: identity.primary.id, missing, known, hostAttributes: stampContentBlock(resolvedId) };
    }

    // Each slot writes back to exactly where its token came from. Excluded, phrase-marked,
    // code and nested content-block subtrees yield no slot, so they are left intact.
    renderSlots(slots, entries, scope.locale, scope.logger);

    return { html: serialize(fragment), customId: identity.primary.id, missing, known, hostAttributes: stampContentBlock(resolvedId) };
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
