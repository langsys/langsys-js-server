/**
 * Tests for the client-DOM parity probe (`_dev_/client-dom-parity.js`).
 *
 * The probe is going to be run by someone else, on a deployment I cannot see, and its
 * output will be treated as evidence. So it has to be shown to DETECT the thing it looks
 * for before anyone runs it — otherwise a clean result from a real page is
 * indistinguishable from a probe that compares nothing.
 *
 * These are majority-negative on purpose: most of them construct a page that IS broken
 * and require the probe to say so.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import * as sdk from 'langsys-js-typescript';

type ProbeResult = {
    ok: boolean;
    checked: number;
    matched: number;
    mismatched: number;
    unresolved: number;
    reason?: string;
    results: Array<{
        status: string;
        servedTokens?: string[];
        liveTokens?: string[];
        arityChanged?: boolean;
        servedCustomId?: string;
        liveCustomId?: string;
        note?: string;
    }>;
};

declare const langsysClientDomParity: (o: unknown) => Promise<ProbeResult>;
declare const langsysClientDomParitySelfTest: (o: unknown) => { discriminates: boolean };

/**
 * Build a page whose LIVE dom and SERVED bytes can differ independently, then run the
 * probe against it.
 */
async function runProbe(servedHtml: string, mutateLive?: (doc: Document) => void) {
    const window = new Window({ url: 'https://example.test/it/page' });
    const document = window.document;
    document.write(servedHtml);
    if (mutateLive) mutateLive(document as unknown as Document);

    const fetchStub = vi.fn(async () => new Response(servedHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
    }));

    Object.assign(globalThis, {
        window,
        document,
        Node: window.Node,
        DOMParser: window.DOMParser,
        location: window.location,
        fetch: fetchStub,
        console: globalThis.console,
    });

    const probeSrc = readFileSync(new URL('../_dev_/client-dom-parity.js', import.meta.url), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(probeSrc)();

    const result = await (globalThis as unknown as { langsysClientDomParity: typeof langsysClientDomParity })
        .langsysClientDomParity({ sdk });

    return { result, fetchStub };
}

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
});

const PAGE = (inner: string) =>
    `<!doctype html><html lang="it"><body><main><div data-langsys-contentblock data-langsys-category="marketing">${inner}</div></main></body></html>`;

describe('the probe detects what it exists to detect', () => {
    it('reports a MISMATCH when hydration splits a text run', async () => {
        // The Svelte-shaped hazard: served bytes carry one whole text run, the hydrated
        // DOM splits it at the interpolation. Same visible text, different token arity,
        // different custom_id.
        const { result } = await runProbe(PAGE('Hello Bob, you have 3 items'), (doc) => {
            const block = doc.querySelector('[data-langsys-contentblock]')!;
            block.textContent = '';
            for (const chunk of ['Hello ', 'Bob', ', you have ', '3', ' items']) {
                block.appendChild(doc.createTextNode(chunk));
            }
        });

        expect(result.ok).toBe(false);
        expect(result.mismatched).toBe(1);

        const finding = result.results.find((r) => r.status === 'MISMATCH')!;
        expect(finding).toBeTruthy();
        expect(finding.arityChanged).toBe(true);
        expect(finding.servedTokens).toEqual(['Hello Bob, you have 3 items']);
        expect(finding.liveTokens).toEqual(['Hello', 'Bob', ', you have', '3', 'items']);
        // The consequence, spelled out: two different catalog entries.
        expect(finding.servedCustomId).not.toBe(finding.liveCustomId);
    });

    it('reports a MISMATCH when hydration MERGES a text run', async () => {
        // The mirror image: served bytes are split (React's `<!-- -->` shape), hydration
        // coalesces them.
        const { result } = await runProbe(PAGE('Hello <!-- -->Bob<!-- -->!'), (doc) => {
            const block = doc.querySelector('[data-langsys-contentblock]')!;
            block.textContent = 'Hello Bob!';
        });

        expect(result.ok).toBe(false);
        const finding = result.results.find((r) => r.status === 'MISMATCH')!;
        expect(finding.servedTokens).toEqual(['Hello', 'Bob', '!']);
        expect(finding.liveTokens).toEqual(['Hello Bob!']);
        expect(finding.arityChanged).toBe(true);
    });

    it('reports a MISMATCH when hydration changes a translatable ATTRIBUTE', async () => {
        const { result } = await runProbe(PAGE('<img alt="Un gatto">Body'), (doc) => {
            doc.querySelector('img')!.setAttribute('alt', 'A cat');
        });

        expect(result.ok).toBe(false);
        const finding = result.results.find((r) => r.status === 'MISMATCH')!;
        expect(finding.servedTokens).toEqual(['Un gatto', 'Body']);
        expect(finding.liveTokens).toEqual(['A cat', 'Body']);
        // Same arity — proves the probe is comparing token VALUES, not just counting.
        expect(finding.arityChanged).toBe(false);
    });

    it('flags content that exists live but not in the served bytes', async () => {
        const { result } = await runProbe(
            `<!doctype html><html lang="it"><body><main></main></body></html>`,
            (doc) => {
                const block = doc.createElement('div');
                block.setAttribute('data-langsys-contentblock', '');
                block.textContent = 'Rendered only on the client';
                doc.querySelector('main')!.appendChild(block);
            },
        );

        const finding = result.results.find((r) => r.status === 'client-only')!;
        expect(finding).toBeTruthy();
        expect(finding.note).toContain('not crawler-visible');
    });
});

describe('the probe does NOT cry wolf', () => {
    it('reports a clean page as clean', async () => {
        const { result } = await runProbe(PAGE('Ciao mondo'));

        expect(result.ok).toBe(true);
        expect(result.matched).toBe(1);
        expect(result.mismatched).toBe(0);
    });

    it('tolerates hydration that changes only NON-translatable attributes', async () => {
        // Frameworks routinely stamp class names, ids and data-* hydration keys. None of
        // those are translatable, so none may move the id — and a probe that flagged them
        // would be useless noise on every real page.
        const { result } = await runProbe(PAGE('<span title="Titolo">Ciao</span>'), (doc) => {
            const span = doc.querySelector('span')!;
            span.setAttribute('class', 'svelte-x1y2z3');
            span.setAttribute('data-hydrated', 'true');
            span.setAttribute('style', 'color:red');
        });

        expect(result.ok).toBe(true);
        expect(result.matched).toBe(1);
    });

    it('reports "no markers found" as inconclusive rather than as a pass', async () => {
        const { result } = await runProbe(
            '<!doctype html><html lang="it"><body><main><p>Nothing marked here</p></main></body></html>',
        );

        // The critical property: `ok` must NOT be true. "Nothing to check" and
        // "everything checked out" are different results and must not print the same.
        expect(result.ok).toBe(false);
        expect(result.checked).toBe(0);
        expect(result.reason).toContain('not an error');
    });
});

describe('the probe measures the right document', () => {
    it('re-fetches the served bytes rather than reading the live DOM twice', async () => {
        const { fetchStub } = await runProbe(PAGE('Ciao'));
        expect(fetchStub).toHaveBeenCalledOnce();
        // `cache: 'reload'` matters: a bfcache hit would measure what the browser
        // remembers, not what the server sends now.
        const init = fetchStub.mock.calls[0][1] as RequestInit | undefined;
        expect(init?.cache).toBe('reload');
    });
});

describe('self-test', () => {
    it('confirms the tokenizer discriminates text-node arity', async () => {
        const window = new Window({ url: 'https://example.test/' });
        Object.assign(globalThis, { window, document: window.document, Node: window.Node });

        const probeSrc = readFileSync(new URL('../_dev_/client-dom-parity.js', import.meta.url), 'utf8');
        // eslint-disable-next-line no-new-func
        new Function(probeSrc)();

        const out = (globalThis as unknown as { langsysClientDomParitySelfTest: typeof langsysClientDomParitySelfTest })
            .langsysClientDomParitySelfTest({ sdk });

        expect(out.discriminates).toBe(true);
    });
});
