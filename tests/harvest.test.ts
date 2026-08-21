/**
 * Harvesting behaviour.
 *
 * Every test here is about something that fails SILENTLY when it regresses: a queue that
 * never drains, a write key that pollutes a shared catalog, a registration that blocks
 * TTFB, a failure that vanishes. None of them throw, so none of them would be noticed
 * without an assertion.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t } from '../src/index.js';
import { __resetWarnOnce } from '../src/logger.js';

interface Registered {
    type: string;
    phrase?: string;
    category?: string;
}

function harness(opts: { keyType?: string; registerFails?: boolean; registerDelayMs?: number } = {}) {
    const registered: Registered[][] = [];
    let registerCalls = 0;

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);

        if (href.includes('authorize-project')) {
            return new Response(
                JSON.stringify({ status: true, data: { key_type: opts.keyType ?? 'write' } }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }

        if (href.includes('translatable-items')) {
            registerCalls++;
            if (opts.registerDelayMs) await new Promise((r) => setTimeout(r, opts.registerDelayMs));
            const body = JSON.parse(String(init?.body)) as { translatable_items: Registered[] };
            registered.push(body.translatable_items);
            if (opts.registerFails) {
                return new Response(JSON.stringify({ status: false, errors: ['nope'] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ status: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({ status: true, data: { __uncategorized__: { Known: 'Conosciuto' } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;

    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        fetch: fetchImpl,
    });

    return { langsys, registered, registerCalls: () => registerCalls };
}

/** Let the scheduled (setImmediate) drain run. */
const settleDrain = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
    __resetWarnOnce();
    vi.restoreAllMocks();
});

describe('the harness itself', () => {
    it('registers at all, or every assertion below is vacuous', async () => {
        const h = harness();
        await h.langsys.run({ locale: 'it' }, () => t('Brand new phrase'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
        expect(h.registered[0]).toEqual([
            { type: 'phrase', phrase: 'Brand new phrase', category: '' },
        ]);
    });
});

describe('deduplication', () => {
    it('posts a phrase rendered fifty times exactly once', async () => {
        const h = harness();
        await h.langsys.run({ locale: 'it' }, () => {
            for (let i = 0; i < 50; i++) t('Repeated phrase');
        });
        await settleDrain();

        expect(h.registered[0]).toHaveLength(1);
    });

    it('treats the same phrase under different categories as distinct', async () => {
        const h = harness();
        await h.langsys.run({ locale: 'it' }, () => {
            t('Same', 'alpha');
            t('Same', 'beta');
            t('Same', 'alpha');
        });
        await settleDrain();

        expect(h.registered[0]).toHaveLength(2);
        expect(h.registered[0].map((i) => i.category).sort()).toEqual(['alpha', 'beta']);
    });

    it('does not queue phrases the catalog resolved', async () => {
        const h = harness();
        const res = await h.langsys.run({ locale: 'it' }, () => t('Known'));
        expect(res.value).toBe('Conosciuto');
        expect(res.missing).toEqual([]);
    });
});

describe('write-key gating', () => {
    it('refuses locally under a read-only key and never makes the call', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'read' });

        const res = await h.langsys.run({ locale: 'it' }, () => t('Would pollute production'));
        await settleDrain();

        // The render is unaffected — a read-only key is correct production
        // configuration, not an error condition.
        expect(res.value).toBe('Would pollute production');
        // And no registration went out.
        expect(h.registerCalls()).toBe(0);
        // And it was NOT silent. The base SDK gates this log behind `if (debug)`, which
        // makes it invisible in the default configuration; that gate is not copied.
        expect(warn).toHaveBeenCalled();
        // Assert across ALL warnings rather than positionally: other once-per-process
        // warnings (e.g. no shared cache) legitimately fire in the same run, and pinning
        // to calls[0] makes this test fail for reasons unrelated to what it checks.
        const messages = warn.mock.calls.map((c) => c.join(' '));
        expect(messages.some((m) => m.includes('read-only'))).toBe(true);
    });

    it('logs the refusal once per process, not once per phrase', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'read' });

        for (let i = 0; i < 5; i++) {
            await h.langsys.run({ locale: 'it' }, () => t(`Phrase ${i}`));
            await settleDrain();
        }

        const refusals = warn.mock.calls.filter((c) => c.join(' ').includes('read-only'));
        expect(refusals).toHaveLength(1);
    });

    it('refuses under an unknown key type too', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'mystery' });
        await h.langsys.run({ locale: 'it' }, () => t('X'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);
    });

    it('harvests under a write key — the positive control', async () => {
        const h = harness({ keyType: 'write' });
        await h.langsys.run({ locale: 'it' }, () => t('X'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });
});

describe('never in the TTFB path', () => {
    it('returns the render before the registration call is made', async () => {
        const h = harness({ registerDelayMs: 50 });

        const started = Date.now();
        const res = await h.langsys.run({ locale: 'it' }, () => t('Slow to register'));
        const elapsed = Date.now() - started;

        expect(res.value).toBe('Slow to register');
        // The 50ms registration must not be inside this measurement.
        expect(elapsed).toBeLessThan(40);
        // Prove the registration had genuinely not happened yet, rather than relying on
        // a timing threshold alone.
        expect(h.registerCalls()).toBe(0);

        await settleDrain();
        await new Promise((r) => setTimeout(r, 60));
        expect(h.registerCalls()).toBe(1);
    });
});

describe('fire-and-forget, but not silent', () => {
    it('logs a failed registration without failing the render', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ registerFails: true });

        const res = await h.langsys.run({ locale: 'it' }, () => t('Doomed'));
        await settleDrain();

        expect(res.value).toBe('Doomed');
        expect(error).toHaveBeenCalled();
        const messages = error.mock.calls.map((c) => c.join(' '));
        expect(messages.some((m) => m.includes('Failed to register'))).toBe(true);
    });

    it('survives a registration that throws', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const throwing = (async (url: string | URL) => {
            const href = String(url);
            if (href.includes('authorize-project'))
                return new Response(JSON.stringify({ status: true, data: { key_type: 'write' } }), { status: 200 });
            if (href.includes('translatable-items')) throw new Error('network down');
            return new Response(JSON.stringify({ status: true, data: {} }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', fetch: throwing });
        const res = await langsys.run({ locale: 'it' }, () => t('Doomed'));
        await settleDrain();

        expect(res.value).toBe('Doomed');
        expect(error).toHaveBeenCalled();
    });
});

describe('flush() for edge runtimes', () => {
    it('drains synchronously when awaited, for ctx.waitUntil', async () => {
        const h = harness();
        const res = await h.langsys.run({ locale: 'it' }, () => t('Edge phrase'));

        await h.langsys.flush(res);

        expect(h.registerCalls()).toBe(1);
        expect(h.registered[0][0].phrase).toBe('Edge phrase');
    });
});
