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
import { createLogger, type Logger } from './logger.js';

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
    /** True when the HTML contains nothing this version cannot translate. */
    clean: boolean;
}

const CONTENT_BLOCK_MARKERS = ['data-langsys-contentblock', 'data-ls-contentblock'];

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
export function auditRenderedHtml(html: string, logger?: Logger): AuditResult {
    const findings: AuditFinding[] = [];

    const visit = (node: Node): void => {
        if (isElement(node)) {
            for (const marker of [...PHRASE_MARKER_ATTRS, ...CONTENT_BLOCK_MARKERS]) {
                if (!node.attrs.some((a) => a.name === marker)) continue;
                const excerpt = textOf(node).replace(/\s+/g, ' ').trim().slice(0, 80);
                findings.push({
                    kind: PHRASE_MARKER_ATTRS.includes(marker as (typeof PHRASE_MARKER_ATTRS)[number])
                        ? 'phrase'
                        : 'content-block',
                    marker,
                    excerpt,
                });
                break;
            }
        }
        if (hasChildNodes(node)) for (const child of node.childNodes) visit(child);
    };

    for (const node of parseFragment(html).childNodes) visit(node);

    if (findings.length > 0 && logger) {
        const log = logger ?? createLogger(false);
        log.warn(
            `Found ${findings.length} element(s) this version does not translate during ` +
                'server render: <Phrase> and <Translate> are client-side only in 0.1.0, so ' +
                'the text below is served in the BASE language and is what a crawler indexes. ' +
                'See the capability matrix in the README.\n' +
                findings.map((f) => `  [${f.kind}] ${f.excerpt || '(no text)'}`).join('\n'),
        );
    }

    return { findings, clean: findings.length === 0 };
}
