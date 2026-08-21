/**
 * Partial-coverage detection.
 *
 * v0.1.0 translates `t()` server-side. It does NOT translate the `<Phrase>` and
 * `<Translate>` components — those need per-framework child-capture adapters, which land
 * in 0.2.0.
 *
 * Staged shipping is fine. **Silent** partial coverage is not, and it is worse than the
 * problem this package was built to fix: some primitives translate server-side and some
 * do not, inside one API, with nothing to distinguish them. That is precisely the
 * failure that let the original defect survive four documents and a year — the SSR
 * documentation claimed a capability it did not have, and nothing signalled.
 *
 * So this converts silent partial coverage into a signal. Run it over your rendered HTML
 * in development and it tells you exactly which content is still base-language.
 *
 * It is a development aid and is not called automatically: scanning every response would
 * put a parse in the TTFB path for a check that only matters while you are building.
 */

import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { PHRASE_MARKER_ATTRS } from './constants.js';
import type { Logger } from './logger.js';

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

export interface AuditFinding {
    kind: 'phrase' | 'content-block';
    /** The marker attribute that identified it. */
    marker: string;
    /** A short excerpt, for locating it in the source. */
    excerpt: string;
}

export interface AuditResult {
    findings: AuditFinding[];
    /**
     * True when the HTML contains nothing this version cannot translate.
     *
     * **This covers `<Phrase>` only unless you pass `contentBlockAttributes`.** A
     * `<Translate>` stamps no attribute on its host, so it cannot be found by marker —
     * `clean: true` means "no phrase markers found", not "nothing is untranslated".
     */
    clean: boolean;
}

export interface AuditOptions {
    /**
     * Attribute names that mark a content-block host in YOUR markup.
     *
     * Required to audit `<Translate>` at all: the SDK stamps nothing on those elements,
     * so there is no marker to look for. If your app adds its own (e.g. `data-block`),
     * name it here.
     */
    contentBlockAttributes?: readonly string[];
}

/**
 * Content blocks are NOT findable by marker, and this is verified rather than assumed.
 *
 * Counted in `langsys-js-typescript@0.6.5` `dist/index.mjs`:
 *
 *     data-langsys-contentblock   0 occurrences
 *     data-ls-contentblock        0 occurrences
 *
 * The only `setAttribute` calls in the whole artifact are `src` on `<img>` (`:1314`) and
 * translated-attribute write-back (`:1579-1580`). A `<Translate>` holds its `custom_id`
 * in a JS field and stamps nothing on the element.
 *
 * An earlier version of this file queried those two invented attribute names — the same
 * defect that shipped briefly in `_dev_/client-dom-parity.js` and was caught there by the
 * reference deployment. Callers who want content blocks audited must pass a `selector`.
 */
const CONTENT_BLOCK_MARKERS: readonly string[] = [];

function isElement(node: Node): node is Element {
    return 'tagName' in node && typeof (node as Element).tagName === 'string';
}

function hasChildNodes(node: Node): node is ParentNode {
    const children = (node as ParentNode).childNodes;
    return Array.isArray(children) && children.length > 0;
}

function textOf(node: Node): string {
    if (node.nodeName === '#text') return (node as { value: string }).value;
    if (!hasChildNodes(node)) return '';
    return node.childNodes.map(textOf).join('');
}

/**
 * Scan rendered HTML for primitives this version does not translate server-side.
 *
 * Pass a logger to have findings warned about; otherwise inspect the result yourself.
 */
export function auditRenderedHtml(
    html: string,
    logger?: Logger,
    options: AuditOptions = {},
): AuditResult {
    const findings: AuditFinding[] = [];
    const blockAttrs = options.contentBlockAttributes ?? CONTENT_BLOCK_MARKERS;

    const visit = (node: Node): void => {
        if (isElement(node)) {
            for (const marker of [...PHRASE_MARKER_ATTRS, ...blockAttrs]) {
                if (!node.attrs.some((a) => a.name === marker)) continue;
                const excerpt = textOf(node).replace(/\s+/g, ' ').trim().slice(0, 80);
                findings.push({
                    kind: (PHRASE_MARKER_ATTRS as readonly string[]).includes(marker)
                        ? 'phrase'
                        : 'content-block',
                    marker,
                    excerpt,
                });
                // One finding per element. Without this, an element carrying both marker
                // spellings is reported twice for one problem.
                break;
            }
        }
        if (hasChildNodes(node)) for (const child of node.childNodes) visit(child);
    };

    for (const node of parseFragment(html).childNodes) visit(node);

    if (findings.length > 0 && logger) {
        logger.warn(
            `Found ${findings.length} element(s) this version does not translate during ` +
                'server render: <Phrase> and <Translate> are client-side only in 0.1.0, so ' +
                'the text below is served in the BASE language and is what a crawler indexes. ' +
                'See the capability matrix in the README.\n' +
                findings.map((f) => `  [${f.kind}] ${f.excerpt || '(no text)'}`).join('\n'),
        );
    }

    return { findings, clean: findings.length === 0 };
}
