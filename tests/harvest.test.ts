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
import type { SharedCache } from '../src/types.js';

interface Registered {
    type: string;
    phrase?: string;
    category?: string;
}

function harness(
    opts: {
        keyType?: string;
        registerFails?: boolean;
        registerDelayMs?: number;
        /**
         * `write_enabled` as the AUTHORIZE endpoint reports it — inside `data`, beside
         * `key_type`. Left out of the payload entirely when `undefined`, which is the
         * pre-capability server GATE-8 governs. Any other value is sent verbatim, so
         * malformed payloads can be modelled.
         */
        writeEnabled?: unknown;
        /**
         * `write_enabled` as the TRANSLATIONS endpoint reports it — at ENVELOPE level,
         * sibling of `data`. Mutable via the returned `setCatalogWriteEnabled` so a
         * server that changes its answer mid-process can be modelled.
         */
        catalogWriteEnabled?: boolean;
        /**
         * `langsys_settings.translatable_items.batch_limit` on the authorize response.
         * Nested exactly as the server nests it — reading one level short silently keeps
         * the SDK on its own default, which is how this was missed in the PHP lane.
         * Sent verbatim so malformed and out-of-range values can be modelled.
         */
        batchLimit?: unknown;
        /** A shared cache, so a second instance can be served a catalog off the cache. */
        cache?: SharedCache;
    } = {},
) {
    const registered: Registered[][] = [];
    let registerCalls = 0;
    let authorizeCalls = 0;
    let catalogWriteEnabled = opts.catalogWriteEnabled;

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);

        if (href.includes('authorize-project')) {
            authorizeCalls++;
            const data: Record<string, unknown> = { key_type: opts.keyType ?? 'write' };
            if (opts.writeEnabled !== undefined) data.write_enabled = opts.writeEnabled;
            if (opts.batchLimit !== undefined) {
                data.langsys_settings = { translatable_items: { batch_limit: opts.batchLimit } };
            }
            return new Response(JSON.stringify({ status: true, data }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
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

        const envelope: Record<string, unknown> = {
            status: true,
            data: { __uncategorized__: { Known: 'Conosciuto' } },
        };
        // Envelope level, NOT inside data — the location the spec specifies for this
        // endpoint, and getting it wrong reads as false.
        if (catalogWriteEnabled !== undefined) envelope.write_enabled = catalogWriteEnabled;
        return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;

    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        fetch: fetchImpl,
        cache: opts.cache,
        // Catalogs are re-fetched per locale; a zero TTL is not needed because each test
        // that needs a second response uses a second locale.
    });

    return {
        langsys,
        registered,
        registerCalls: () => registerCalls,
        authorizeCalls: () => authorizeCalls,
        setCatalogWriteEnabled: (v: boolean | undefined) => (catalogWriteEnabled = v),
    };
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

describe('GATE-1 — the decision is the server\'s write_enabled, never the key type', () => {
    /**
     * `key_type` describes the KEY; capability is per SESSION. The same `ip_write` key is
     * read-only from most addresses and write-capable from an allow-listed one, so no
     * client-side value can express the answer.
     *
     * Measured against 0.1.0, this failed in BOTH directions, and the two failures cost
     * different things. False-open (`write_enabled: false` on a write key, registering
     * anyway) writes into a catalog the server just refused. False-closed (`write_enabled:
     * true` on a read or `ip_write` key, refusing) is the one that defeats discovery
     * outright — our renderer runs the customer's page through their own unmodified SDK
     * on an `ip_write` key, so a `key_type === 'write'` test means the renderer silently
     * registers nothing.
     */
    it('refuses when the server says false, even on a write key', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'write', writeEnabled: false });
        await h.langsys.run({ locale: 'it' }, () => t('Refused'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);
    });

    it('registers when the server says true on a READ key', async () => {
        const h = harness({ keyType: 'read', writeEnabled: true });
        await h.langsys.run({ locale: 'it' }, () => t('Permitted'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });

    it('registers when the server says true on an ip_write key — the discovery renderer', async () => {
        const h = harness({ keyType: 'ip_write', writeEnabled: true });
        await h.langsys.run({ locale: 'it' }, () => t('From an allow-listed address'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });

    it('refuses the same ip_write key when the server says false', async () => {
        // GATE-1's own test: one key, two addresses, only the apparent origin differing.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'ip_write', writeEnabled: false });
        await h.langsys.run({ locale: 'it' }, () => t('From anywhere else'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);
    });

    it('reads the flag from the TRANSLATIONS envelope, not from inside data', async () => {
        // Location differs by endpoint, and reading the wrong one reads as false.
        const h = harness({ keyType: 'read', catalogWriteEnabled: true });
        await h.langsys.run({ locale: 'it' }, () => t('Enveloped'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });
});

describe('GATE-8 — a missing write_enabled is a version signal, never permission', () => {
    it('falls back to key_type for a PLAIN WRITE key when the field is absent', async () => {
        const h = harness({ keyType: 'write' }); // writeEnabled omitted entirely
        await h.langsys.run({ locale: 'it' }, () => t('Pre-capability server'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });

    it('does NOT infer a write decision for ip_write when the field is absent', async () => {
        // Constraint 1. For an address-dependent key the absence of a positive signal IS
        // the answer; inferring around it converts a closed gate into an open one.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'ip_write' });
        await h.langsys.run({ locale: 'it' }, () => t('Must not register'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);

        // The MESSAGE is asserted, not just the refusal. Deleting the ip_write branch
        // leaves the refusal intact — it falls through to the generic `!== 'write'` arm —
        // so a count-only test passes against code that tells an ip_write owner their
        // "key type could not be determined... authorization probably failed". That
        // sends them to re-check credentials that are fine, when the actual fix is an
        // allow-list entry for this server's address. The mutation that proved this test
        // was toothless is exactly that deletion.
        const messages = warn.mock.calls.map((c) => c.join(' '));
        expect(messages.some((m) => m.includes('ip_write'))).toBe(true);
        expect(messages.some((m) => m.includes('authorization failed'))).toBe(false);
    });

    it('does not fall back for a read key', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'read' });
        await h.langsys.run({ locale: 'it' }, () => t('X'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);
    });

    it('treats the truthy STRING "false" as absent rather than as permission', async () => {
        // The vector matters more than the rule here. A first draft of this test passed
        // `null` against an ip_write key and survived a mutation that replaced the
        // boolean check with `Boolean(value)` — because `Boolean(null)` is false and an
        // ip_write key refuses either way, so the coercion and the correct code agreed.
        //
        // `"false"` on a READ key is the vector that discriminates: coerced it is `true`
        // and the gate OPENS on a read-only key; read correctly it is absent, GATE-8
        // declines to infer for anything but a plain write key, and the gate stays shut.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'read', writeEnabled: 'false' });
        await h.langsys.run({ locale: 'it' }, () => t('Must not register'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);
    });

    it('treats a falsy NON-BOOLEAN as absent too, so the fallback still applies', async () => {
        // The other direction, and the reason "absent" is not a synonym for "false":
        // coercing `0` to `false` would refuse a plain write key that GATE-8 permits.
        const h = harness({ keyType: 'write', writeEnabled: 0 });
        await h.langsys.run({ locale: 'it' }, () => t('Should register'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });

    it('is re-evaluated per response, not latched at init', async () => {
        // Constraint 2. A server upgraded mid-deployment must be picked up without an SDK
        // release. The catalog fetch is the per-response re-evaluation: it carries the
        // flag on its envelope and happens once per locale per TTL.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ keyType: 'read', catalogWriteEnabled: false });

        await h.langsys.run({ locale: 'it' }, () => t('Before the upgrade'));
        await settleDrain();
        expect(h.registerCalls()).toBe(0);

        // The server gains the capability. A different locale forces a fresh response.
        h.setCatalogWriteEnabled(true);
        await h.langsys.run({ locale: 'fr' }, () => t('After the upgrade'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });

    it('constraint 5 — never applies the fallback from a CACHED payload', async () => {
        /**
         * GATE-4 strips `write_enabled` before anything is cached, so a cache read is
         * byte-indistinguishable from a pre-capability server's response: the same
         * absence, arrived at deliberately. Treating it as a version signal converts our
         * own privacy measure into inferred permission — on the path that serves most
         * requests, which is what makes it worth a test rather than a comment.
         *
         * Here the server DOES speak capability and says false, on a `write` key. A
         * second instance is then served the catalog off the shared cache. If the cached
         * absence were read as "pre-capability", GATE-8 would fall back to
         * `key_type === 'write'` and register — the gate opening because the cache
         * answered instead of the wire.
         */
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = new Map<string, string>();
        const cache: SharedCache = {
            get: (k) => store.get(k) ?? null,
            set: (k, v) => void store.set(k, v),
            delete: (k) => void store.delete(k),
        };

        const first = harness({ keyType: 'write', writeEnabled: false, cache });
        await first.langsys.run({ locale: 'it' }, () => t('Seeds the cache'));
        await settleDrain();
        expect(store.size).toBe(1); // the catalog really is cached, or the rest is vacuous

        const second = harness({ keyType: 'write', writeEnabled: false, cache });
        await second.langsys.run({ locale: 'it' }, () => t('Served from cache'));
        await settleDrain();
        expect(second.registerCalls()).toBe(0);
    });

    it('POSITIVE CONTROL: a cached catalog does not stop a permitted session registering', async () => {
        // The other half of constraint 5's test. Without it, the assertion above is
        // satisfiable by an implementation that never registers once a cache is
        // configured at all — which would pass while breaking harvesting outright.
        const store = new Map<string, string>();
        const cache: SharedCache = {
            get: (k) => store.get(k) ?? null,
            set: (k, v) => void store.set(k, v),
            delete: (k) => void store.delete(k),
        };

        const first = harness({ keyType: 'write', writeEnabled: true, cache });
        await first.langsys.run({ locale: 'it' }, () => t('Seeds the cache'));
        await settleDrain();

        const second = harness({ keyType: 'write', writeEnabled: true, cache });
        await second.langsys.run({ locale: 'it' }, () => t('Served from cache'));
        await settleDrain();
        expect(second.registerCalls()).toBe(1);
    });

    it('POSITIVE CONTROL: the harness registers when everything permits it', async () => {
        const h = harness({ keyType: 'write', writeEnabled: true });
        await h.langsys.run({ locale: 'it' }, () => t('Plainly allowed'));
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });
});

describe('REG-9 — batch to the server-provided limit, on every path', () => {
    /**
     * The server ENFORCES this cap and rejects an oversized batch, so exceeding it does
     * not merely send a large request — it fails the whole registration, and every phrase
     * in it is lost. Measured against 0.1.0: 430 phrases went out as a single POST of 430
     * with the limit never read at all.
     *
     * `langsys_settings.translatable_items.batch_limit`, nested exactly that deep. Reading
     * one level short returns `undefined` and silently keeps the SDK's own default, which
     * looks identical to a server that did not send one.
     */
    const render = async (h: ReturnType<typeof harness>, count: number) => {
        await h.langsys.run({ locale: 'it' }, () => {
            for (let i = 0; i < count; i++) t(`Phrase ${i}`);
        });
        await settleDrain();
    };
    const sizes = (h: ReturnType<typeof harness>) => h.registered.map((b) => b.length);

    it('chunks to the advertised limit', async () => {
        const h = harness({ batchLimit: 5 });
        await render(h, 12);
        expect(sizes(h)).toEqual([5, 5, 2]);
    });

    it('sends every phrase exactly once across the chunks', async () => {
        // Chunking that drops or duplicates a phrase is worse than not chunking.
        const h = harness({ batchLimit: 7 });
        await render(h, 30);
        const all = h.registered.flat().map((r) => r.phrase);
        expect(all).toHaveLength(30);
        expect(new Set(all).size).toBe(30);
    });

    it('defaults to 200 when the server advertises nothing', async () => {
        const h = harness();
        await render(h, 250);
        expect(sizes(h)).toEqual([200, 50]);
    });

    it('POSITIVE CONTROL: a batch under the limit is still one POST', async () => {
        // Without this, "chunks correctly" is satisfiable by chunking to 1.
        const h = harness({ batchLimit: 5 });
        await render(h, 3);
        expect(sizes(h)).toEqual([3]);
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['a string', '5'],
        ['null', null],
        ['a float below one', 0.5],
    ])('falls back to the default when the limit is %s', async (_label, limit) => {
        // REG-9's guard. A limit of 0 chunks into empty batches forever; a negative one
        // does the same. Neither is a value the SDK may adopt, and neither should be
        // coerced into one.
        const h = harness({ batchLimit: limit });
        await render(h, 250);
        expect(sizes(h)).toEqual([200, 50]);
    });

    it('applies the limit on the flush() path too, not only the scheduled drain', async () => {
        // "on every path" is the part REG-9 names explicitly: the PHP SDK batched on its
        // queue path and looped one POST per block on the HTML path.
        const h = harness({ batchLimit: 4 });
        const result = await h.langsys.run({ locale: 'it' }, () => {
            for (let i = 0; i < 9; i++) t(`Phrase ${i}`);
        });
        await h.langsys.flush(result);
        expect(sizes(h)).toEqual([4, 4, 1]);
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

    it('does NOT double-post when the scheduled drain also fires', async () => {
        // The documented Workers path is `run()` then `ctx.waitUntil(flush(result))`, and
        // `run()` schedules a drain unconditionally. This test previously ended at the
        // assertion above — measured immediately after `await flush()`, before the
        // scheduled drain had run — so the count was 1 at the one moment it was still 1.
        // Waiting for the tick showed 2: every phrase registered twice against a shared
        // catalog. A test written so the defect cannot produce a signal.
        const h = harness();
        const res = await h.langsys.run({ locale: 'it' }, () => {
            t('Edge alpha');
            t('Edge beta');
        });

        await h.langsys.flush(res);
        await settleDrain();

        expect(h.registerCalls()).toBe(1);
        expect(h.registered.flat()).toHaveLength(2);
    });

    it('does not double-post in the other order either', async () => {
        const h = harness();
        const res = await h.langsys.run({ locale: 'it' }, () => t('Edge gamma'));

        await settleDrain();
        await h.langsys.flush(res);

        expect(h.registerCalls()).toBe(1);
    });

    it('reports loudly when handed something run() did not produce', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness();
        const res = await h.langsys.run({ locale: 'it' }, () => t('Edge delta'));

        // A caller who REBUILDS the result loses the internal scope handle. (An object
        // spread would keep it — spread copies symbol keys — so this reconstructs the
        // public shape explicitly, which is what a serialize/deserialize round-trip does.)
        await h.langsys.flush({
            value: res.value,
            catalog: res.catalog,
            locale: res.locale,
            missing: res.missing,
        });

        expect(error).toHaveBeenCalled();
        expect(error.mock.calls.map((c) => c.join(' ')).join()).toContain('did not come from run()');
    });
});

describe('phrases discovered after the response flushed', () => {
    it('still register, rather than being silently dropped', async () => {
        // A streamed response keeps rendering — and calling t() — after run() resolves.
        // AsyncLocalStorage propagates the scope into that tail, so those phrases RESOLVE
        // correctly; before the late-miss hook they simply never registered.
        const h = harness();
        let releaseTail!: () => void;
        const tailRendered = new Promise<void>((r) => (releaseTail = r));

        const res = await h.langsys.run({ locale: 'it' }, async () => {
            t('Header phrase');
            // A continuation created INSIDE the scope inherits the AsyncLocalStorage
            // context, which is exactly how a streamed body keeps resolving correctly
            // after `resolve(event)` has already settled.
            void tailRendered.then(() => t('Streamed tail phrase'));
        });

        await settleDrain();
        expect(h.registered.flat().map((i) => i.phrase)).toEqual(['Header phrase']);

        // The streamed body renders after the drain.
        releaseTail();
        await settleDrain();

        const all = h.registered.flat().map((i) => i.phrase).sort();
        expect(all).toEqual(['Header phrase', 'Streamed tail phrase']);
        expect(res.missing.map((m) => m.phrase).sort()).toEqual([
            'Header phrase',
            'Streamed tail phrase',
        ]);
    });

    it('does not re-post phrases that already went out', async () => {
        const h = harness();
        let releaseTail!: () => void;
        const tailRendered = new Promise<void>((r) => (releaseTail = r));

        await h.langsys.run({ locale: 'it' }, async () => {
            t('First');
            void tailRendered.then(() => t('Second'));
        });
        await settleDrain();
        releaseTail();
        await settleDrain();

        const posted = h.registered.flat().map((i) => i.phrase);
        expect(posted).toHaveLength(2);
        expect(new Set(posted).size).toBe(2);
    });
});

describe('a render that throws still harvests', () => {
    it('drains phrases discovered before the error', async () => {
        // An erroring page is exactly where new, unregistered copy tends to live.
        const h = harness();

        await expect(
            h.langsys.run({ locale: 'it' }, () => {
                t('Phrase before the boom');
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        await settleDrain();
        expect(h.registered.flat().map((i) => i.phrase)).toEqual(['Phrase before the boom']);
    });
});
