/**
 * Tests for the client-DOM parity probe (`_dev_/client-dom-parity.js`).
 *
 * The probe is run by other people, on deployments this repo cannot see, and its output
 * is treated as evidence. So it has to be shown to DETECT before anyone runs it —
 * otherwise a clean result is indistinguishable from a probe that compares nothing.
 *
 * Majority-negative on purpose: most cases construct a page that IS broken and require
 * the probe to say so. Several exist specifically because the first version of this
 * probe got them wrong on a real deployment.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import * as sdk from 'langsys-js-typescript';

type Row = {
    status: string;
    mechanism?: string;
    arityChanged?: boolean;
    slotCountChanged?: boolean;
    servedTokens?: string[];
    liveTokens?: string[];
    servedPhrase?: string;
    livePhrase?: string;
    servedCustomId?: string;
    liveCustomId?: string;
    customIdNote?: string;
    note?: string;
};

type ProbeResult = {
    ok: boolean;
    inconclusive?: boolean;
    reason?: string;
    mode: string;
    checked: number;
    pageLocale: string | null;
    counts: Record<string, number>;
    results: Row[];
};

const PROBE_SRC = readFileSync(new URL('../_dev_/client-dom-parity.js', import.meta.url), 'utf8');

async function runProbe(
    servedHtml: string,
    opts: {
        mutateLive?: (doc: Document) => void;
        selector?: string;
        baseLocale?: string;
        category?: string;
        verbose?: boolean;
    } = {},
) {
    const window = new Window({ url: 'https://example.test/page' });
    const document = window.document;
    document.write(servedHtml);
    if (opts.mutateLive) opts.mutateLive(document as unknown as Document);

    const fetchStub = vi.fn(
        async () =>
            new Response(servedHtml, { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    Object.assign(globalThis, {
        window,
        document,
        Node: window.Node,
        DOMParser: window.DOMParser,
        location: window.location,
        fetch: fetchStub,
    });

    // eslint-disable-next-line no-new-func
    new Function(PROBE_SRC)();

    const g = globalThis as unknown as {
        langsysClientDomParity: (o: unknown) => Promise<ProbeResult>;
        langsysClientDomParitySelfTest: (o: unknown) => { pass: boolean; tokensDiscriminate: boolean; phraseIsArityBlind: boolean };
    };

    const result = await g.langsysClientDomParity({
        sdk,
        selector: opts.selector,
        baseLocale: opts.baseLocale,
        category: opts.category,
        verbose: opts.verbose,
    });

    return { result, fetchStub, selfTest: g.langsysClientDomParitySelfTest };
}

/** A page whose content block is findable only by explicit selector — as in reality. */
const BLOCK_PAGE = (inner: string, lang = 'en') =>
    `<!doctype html><html lang="${lang}"><body><main><div data-block>${inner}</div></main></body></html>`;

const PHRASE_PAGE = (inner: string, lang = 'en') =>
    `<!doctype html><html lang="${lang}"><body><main><span data-ls-phrase>${inner}</span></main></body></html>`;

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
describe('self-test guards both of the probe assumptions', () => {
    it('confirms tokenizeElement discriminates arity AND encodeRichText does not', async () => {
        const { selfTest } = await runProbe(BLOCK_PAGE('x'), { selector: '[data-block]' });
        const out = selfTest({ sdk });

        expect(out.tokensDiscriminate).toBe(true);
        // The assumption the first version of this probe got WRONG. <Phrase> coalesces
        // text, so arity cannot matter there — which is why the probe must not compare
        // tokens on phrase elements.
        expect(out.phraseIsArityBlind).toBe(true);
        expect(out.pass).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe('content-block path: it detects what it exists to detect', () => {
    it('reports MISMATCH when hydration SPLITS a text run', async () => {
        const { result } = await runProbe(BLOCK_PAGE('Hello Bob, you have 3 items'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => {
                const block = doc.querySelector('[data-block]')!;
                block.textContent = '';
                for (const c of ['Hello ', 'Bob', ', you have ', '3', ' items']) {
                    block.appendChild(doc.createTextNode(c));
                }
            },
        });

        expect(result.ok).toBe(false);
        const row = result.results.find((r) => r.status === 'MISMATCH')!;
        expect(row.arityChanged).toBe(true);
        expect(row.servedTokens).toEqual(['Hello Bob, you have 3 items']);
        expect(row.liveTokens).toEqual(['Hello', 'Bob', ', you have', '3', 'items']);
        expect(row.note).toContain('re-keys');
    });

    it('reports MISMATCH when hydration MERGES a text run', async () => {
        const { result } = await runProbe(BLOCK_PAGE('Hello <!-- -->Bob<!-- -->!'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => {
                doc.querySelector('[data-block]')!.textContent = 'Hello Bob!';
            },
        });

        expect(result.ok).toBe(false);
        const row = result.results.find((r) => r.status === 'MISMATCH')!;
        expect(row.servedTokens).toEqual(['Hello', 'Bob', '!']);
        expect(row.liveTokens).toEqual(['Hello Bob!']);
        expect(row.arityChanged).toBe(true);
    });

    it('reports MISMATCH for a changed translatable ATTRIBUTE in the base locale', async () => {
        const { result } = await runProbe(BLOCK_PAGE('<img alt="A cat">Body'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => doc.querySelector('img')!.setAttribute('alt', 'Something else'),
        });

        expect(result.ok).toBe(false);
        const row = result.results.find((r) => r.status === 'MISMATCH')!;
        // Equal arity — proves the probe compares token VALUES, not just counts.
        expect(row.arityChanged).toBe(false);
    });

    it('computes custom_id only when the category is supplied', async () => {
        // Nothing in the DOM carries the category, so a hash over "" is an artifact. The
        // first version of this probe reported one anyway.
        const withoutCategory = await runProbe(BLOCK_PAGE('Text'), {
            selector: '[data-block]',
            baseLocale: 'en',
            verbose: true,
        });
        const rowA = withoutCategory.result.results[0];
        expect(rowA.servedCustomId).toBeUndefined();
        expect(rowA.customIdNote).toContain('artifact');

        const withCategory = await runProbe(BLOCK_PAGE('Text'), {
            selector: '[data-block]',
            baseLocale: 'en',
            category: 'marketing',
            verbose: true,
        });
        const rowB = withCategory.result.results[0];
        expect(rowB.servedCustomId).toMatch(/^[0-9a-f]{32}$/);
        expect(rowB.servedCustomId).toBe(rowB.liveCustomId);
    });
});

// ---------------------------------------------------------------------------
describe('locale handling: a translated page is NOT a failing page', () => {
    it('classifies value-only divergence on a non-base locale as `translated`', async () => {
        // THE false-alarm case. On /it the served bytes carry base language (the client
        // SDK is inert during SSR) and the live DOM has been rewritten by the SDK. Every
        // marked block diverges by value, on every page, forever — and that is the
        // product working. The first version of this probe reported three red rows on a
        // correctly-functioning production site.
        const { result } = await runProbe(BLOCK_PAGE('Hydration begins with better water.', 'it'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => {
                doc.querySelector('[data-block]')!.textContent = "L'idratazione inizia con un'acqua migliore.";
            },
            verbose: true,
        });

        expect(result.ok).toBe(true);
        expect(result.counts.translated).toBe(1);
        expect(result.counts.MISMATCH).toBe(0);
        expect(result.results[0].status).toBe('translated');
    });

    it('still catches a STRUCTURAL break on a non-base locale', async () => {
        // Translation must not become a blanket excuse. Arity changes are still errors.
        const { result } = await runProbe(BLOCK_PAGE('Hydration begins with better water.', 'it'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => {
                const block = doc.querySelector('[data-block]')!;
                block.textContent = '';
                for (const c of ["L'idratazione", ' inizia', " con un'acqua migliore."]) {
                    block.appendChild(doc.createTextNode(c));
                }
            },
        });

        expect(result.ok).toBe(false);
        expect(result.counts.MISMATCH).toBe(1);
        expect(result.results[0].arityChanged).toBe(true);
    });

    it('treats the SAME divergence as a defect in the base locale', async () => {
        // Identical value change, lang=en: no translation swap can explain it.
        const { result } = await runProbe(BLOCK_PAGE('Hello', 'en'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => {
                doc.querySelector('[data-block]')!.textContent = 'Something entirely different';
            },
        });

        expect(result.ok).toBe(false);
        expect(result.counts.MISMATCH).toBe(1);
    });

    it('refuses to judge values when no baseLocale is supplied', async () => {
        const { result } = await runProbe(BLOCK_PAGE('Hello', 'en'), {
            selector: '[data-block]',
            mutateLive: (doc) => {
                doc.querySelector('[data-block]')!.textContent = 'Different';
            },
        });

        expect(result.mode).toContain('NOT judged');
        expect(result.counts.MISMATCH).toBe(0);
        expect(result.counts.translated).toBe(1);
    });
});

// ---------------------------------------------------------------------------
describe('phrase path: keyed on the encoded string, not on tokens', () => {
    it('ignores text-node arity, because encodeRichText coalesces', async () => {
        const { result } = await runProbe(PHRASE_PAGE('Based on <b>5</b> reviews'), {
            baseLocale: 'en',
            mutateLive: (doc) => {
                // Split the leading text run. Under the old token-based comparison this
                // was a false MISMATCH; the phrase path is arity-blind by design.
                const span = doc.querySelector('[data-ls-phrase]')!;
                const b = span.querySelector('b')!;
                span.textContent = '';
                span.appendChild(doc.createTextNode('Based '));
                span.appendChild(doc.createTextNode('on '));
                span.appendChild(b);
                span.appendChild(doc.createTextNode(' reviews'));
            },
            verbose: true,
        });

        expect(result.ok).toBe(true);
        expect(result.results[0].mechanism).toBe('phrase');
        expect(result.results[0].status).toBe('match');
    });

    it('reports MISMATCH when the markup SLOT COUNT changes', async () => {
        const { result } = await runProbe(PHRASE_PAGE('Based on <b>5</b> reviews'), {
            baseLocale: 'en',
            mutateLive: (doc) => {
                const span = doc.querySelector('[data-ls-phrase]')!;
                const em = doc.createElement('em');
                em.textContent = ' now';
                span.appendChild(em);
            },
        });

        expect(result.ok).toBe(false);
        const row = result.results.find((r) => r.status === 'MISMATCH')!;
        expect(row.slotCountChanged).toBe(true);
        expect(row.note).toContain('SLOT COUNT');
    });

    it('never reports tokens or a custom_id for a phrase element', async () => {
        const { result } = await runProbe(PHRASE_PAGE('Whole sentence'), {
            baseLocale: 'en',
            verbose: true,
        });
        const row = result.results[0];
        expect(row.servedTokens).toBeUndefined();
        expect(row.servedCustomId).toBeUndefined();
        expect(row.servedPhrase).toBe('Whole sentence');
    });
});

// ---------------------------------------------------------------------------
describe('it does not cry wolf', () => {
    it('reports a clean base-locale page as clean', async () => {
        const { result } = await runProbe(BLOCK_PAGE('Ciao mondo'), {
            selector: '[data-block]',
            baseLocale: 'en',
        });
        expect(result.ok).toBe(true);
        expect(result.counts.match).toBe(1);
    });

    it('tolerates the class/style/data-* attributes frameworks stamp during hydration', async () => {
        const { result } = await runProbe(BLOCK_PAGE('<span title="Title">Hello</span>'), {
            selector: '[data-block]',
            baseLocale: 'en',
            mutateLive: (doc) => {
                const span = doc.querySelector('span')!;
                span.setAttribute('class', 'svelte-x1y2z3');
                span.setAttribute('data-hydrated', 'true');
                span.setAttribute('style', 'color:red');
            },
        });
        expect(result.ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe('it reports inconclusive rather than passing', () => {
    it('says content blocks are NOT findable by marker when nothing matches', async () => {
        const { result } = await runProbe(
            '<!doctype html><html lang="en"><body><main><p>Nothing marked</p></main></body></html>',
            { baseLocale: 'en' },
        );

        // "Nothing to check" and "everything checked out" must not print the same.
        expect(result.ok).toBe(false);
        expect(result.inconclusive).toBe(true);
        expect(result.checked).toBe(0);
        // And the reason must state the real cause, not imply the page has no blocks.
        expect(result.reason).toContain('NOT findable by marker');
        expect(result.reason).toContain('zero times');
    });

    it('flags content that exists live but not in the served bytes', async () => {
        const { result } = await runProbe(
            '<!doctype html><html lang="en"><body><main></main></body></html>',
            {
                selector: '[data-block]',
                baseLocale: 'en',
                mutateLive: (doc) => {
                    const block = doc.createElement('div');
                    block.setAttribute('data-block', '');
                    block.textContent = 'Client-only';
                    doc.querySelector('main')!.appendChild(block);
                },
            },
        );

        const row = result.results.find((r) => r.status === 'client-only')!;
        expect(row.note).toContain('not crawler-visible');
    });
});

// ---------------------------------------------------------------------------
describe('it measures the right document', () => {
    it('re-fetches the served bytes with cache: reload', async () => {
        const { fetchStub } = await runProbe(BLOCK_PAGE('Ciao'), {
            selector: '[data-block]',
            baseLocale: 'en',
        });
        expect(fetchStub).toHaveBeenCalledOnce();
        const init = fetchStub.mock.calls[0][1] as RequestInit | undefined;
        expect(init?.cache).toBe('reload');
    });
});
