/**
 * Harvesting behaviour.
 *
 * Every test here is about something that fails SILENTLY when it regresses: a queue that
 * never drains, a write key that pollutes a shared catalog, a registration that blocks
 * TTFB, a failure that vanishes. None of them throw, so none of them would be noticed
 * without an assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
        /** Make GET /translations fail, so the catalog is unavailable for the render. */
        catalogFails?: boolean;
    } = {},
) {
    const registered: Registered[][] = [];
    let registerCalls = 0;
    let authorizeCalls = 0;
    let catalogWriteEnabled = opts.catalogWriteEnabled;
    // Mutable, so an endpoint that fails and then recovers can be modelled (REG-8).
    let registerFails = opts.registerFails;
    let registerThrows = false;
    let registerNoContent = false;
    let authorizeFails = false;
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);

        if (href.includes('authorize-project')) {
            authorizeCalls++;
            if (authorizeFails) return new Response('down', { status: 500 });
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
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (opts.registerDelayMs) await new Promise((r) => setTimeout(r, opts.registerDelayMs));
            // Nothing below awaits before returning, so the send has ended here.
            inFlight--;
            if (registerThrows) throw new Error('network down');
            const body = JSON.parse(String(init?.body)) as { translatable_items: Registered[] };
            registered.push(body.translatable_items);
            // WIRE-2: an accepted registration answered with no content at all.
            if (registerNoContent) return new Response(null, { status: 204 });
            if (registerFails) {
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

        if (opts.catalogFails) {
            return new Response('gateway blew up', { status: 502, statusText: 'Bad Gateway' });
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
        setRegisterFails: (v: boolean) => (registerFails = v),
        setRegisterThrows: (v: boolean) => (registerThrows = v),
        maxInFlight: () => maxInFlight,
        setRegisterNoContent: (v: boolean) => (registerNoContent = v),
        setAuthorizeFails: (v: boolean) => (authorizeFails = v),
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

describe('WIRE-4 clause 2 — a failed catalog fetch registers NOTHING', () => {
    /**
     * Without a catalog, a miss is indistinguishable from a hit. Treating the failure as
     * "everything is unknown" re-registers phrases that already exist, so **every outage
     * becomes a write storm** — on exactly the paths that were already failing, and
     * proportional to how much copy the page has.
     *
     * Measured before the fix: a 502 on /translations with 40 phrases rendered produced 40
     * queued and one POST of 40 items. The render degrading to source text is correct and
     * was already true; the registrations were the defect.
     *
     * "Degrade gracefully" alone does not settle this, which is why the spec says it
     * outright: the intuitive answer is the wrong one.
     */
    const render40 = async (h: ReturnType<typeof harness>) => {
        const result = await h.langsys.run({ locale: 'it' }, () => {
            for (let i = 0; i < 40; i++) t(`Phrase ${i}`);
            return 'done';
        });
        await settleDrain();
        await h.langsys.flush(result);
        return result;
    };

    it('queues nothing and sends nothing when the catalog fetch fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ catalogFails: true });
        const result = await render40(h);

        expect(result.missing).toHaveLength(0);
        expect(h.registerCalls()).toBe(0);
    });

    it('still renders source text — degrading is not the same as failing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ catalogFails: true });
        const res = await h.langsys.run({ locale: 'it' }, () => t('Hello'));
        expect(res.value).toBe('Hello');
    });

    it('POSITIVE CONTROL: the same 40 phrases DO register when the catalog loads', async () => {
        // Without this, "registers nothing" is satisfied by a build that never registers
        // anything at all — which would pass while silently disabling harvesting.
        const h = harness();
        await render40(h);
        expect(h.registerCalls()).toBeGreaterThan(0);
        expect(h.registered.flat()).toHaveLength(40);
    });

    it('is not silent — a failed catalog still reports', async () => {
        // The failure must remain loud. A page rendering base language looks identical to
        // a working one in any curl-shaped check, so the log is the only signal.
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ catalogFails: true });
        await h.langsys.run({ locale: 'it' }, () => t('Hello'));
        expect(err.mock.calls.map((c) => c.join(' ')).some((m) => m.includes('Catalog fetch'))).toBe(true);
    });

    it('the PRELOAD path does not storm either — preloadCatalog() then run({ catalog })', async () => {
        /**
         * The shape the reference integration actually uses. `example/src/hooks.server.ts`
         * calls `preloadCatalog(locale)` and hands the result to `run({ locale, catalog })`,
         * because SvelteKit's `+layout.server.ts` reads `event.locals` during
         * `resolve(event)` and assigning after `run()` is too late.
         *
         * The first version of this fix guarded only the INLINE fetch inside `run()`. This
         * path bypassed it completely: `preloadCatalog` discarded the `ok` flag, and a
         * caller-supplied catalog was counted as authoritative on the grounds that the
         * host had taken responsibility for it. The host cannot take responsibility for a
         * failure it was never told about — measured at that commit, this path produced
         * the identical pre-fix numbers, 40 queued and one POST of 40.
         */
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ catalogFails: true });

        const catalog = await h.langsys.preloadCatalog('it');
        const result = await h.langsys.run({ locale: 'it', catalog }, () => {
            for (let i = 0; i < 40; i++) t(`Phrase ${i}`);
            return 'done';
        });
        await settleDrain();
        await h.langsys.flush(result);

        expect(result.missing).toHaveLength(0);
        expect(h.registerCalls()).toBe(0);
    });

    it('POSITIVE CONTROL: the preload path DOES register when the fetch succeeds', async () => {
        // Otherwise the assertion above is satisfied by a preloaded catalog that never
        // registers anything, which would disable harvesting on the documented path.
        const h = harness();
        const catalog = await h.langsys.preloadCatalog('it');
        const result = await h.langsys.run({ locale: 'it', catalog }, () => t('Genuinely new'));
        await settleDrain();
        await h.langsys.flush(result);

        expect(result.missing.map((m) => m.phrase)).toEqual(['Genuinely new']);
        expect(h.registerCalls()).toBe(1);
    });

    it('an explicit catalogAvailable:false wins over anything inferred', async () => {
        // The escape hatch for a host that fetches its own catalog and knows the fetch
        // failed. Without it such a host has no way to say so.
        const h = harness();
        const result = await h.langsys.run(
            { locale: 'it', catalog: { __uncategorized__: {} }, catalogAvailable: false },
            () => t('Should not register'),
        );
        await settleDrain();
        expect(result.missing).toHaveLength(0);
    });

    it('a caller-supplied catalog is NOT treated as a failed fetch', async () => {
        // run({ catalog }) skips the fetch entirely. That is an available catalog, so
        // misses against it are real misses and must still register.
        const h = harness();
        const result = await h.langsys.run(
            { locale: 'it', catalog: { __uncategorized__: { Known: 'Conosciuto' } } },
            () => t('Genuinely new'),
        );
        await settleDrain();
        expect(result.missing.map((m) => m.phrase)).toEqual(['Genuinely new']);
    });
});

describe('REG-6 — the batch that was SENT is what gets marked, not the queue as it stands', () => {
    /**
     * Rowed `implemented` with no test until a review pointed out that a runtime rule
     * graded on "the defect is unrepresentable" is graded above its evidence.
     *
     * **The first version of this test was worthless and a mutation proved it.** It called
     * `run()` twice and asserted nothing was lost — but two `run()` calls are two separate
     * scopes with two separate queues, so no drain of one could ever swallow a miss of the
     * other. Marking the live queue post-await turned it 0 red. The rule is about ONE
     * scope whose queue grows while its own send is in flight, and the only way to reach
     * that from outside is to let the render start work that outlives it: AsyncLocalStorage
     * propagates the scope into anything scheduled inside it, which is exactly the streamed
     * -response tail this package supports.
     *
     * The failure prevented is silent and permanent: success handler re-reads the LIVE
     * queue, marks everything in it registered and empties it, so a phrase recorded
     * mid-request is marked done, discarded unsent, and never retried because it then
     * reads as known.
     */
    it('does not lose a phrase recorded while that scope\'s own send is in flight', async () => {
        const h = harness({ registerDelayMs: 60 });

        let lateDone: () => void;
        const late = new Promise<void>((r) => (lateDone = r));

        const result = await h.langsys.run({ locale: 'it' }, () => {
            t('Early');
            // Scheduled INSIDE the scope, so ALS carries the scope with it. Fires while
            // the drain triggered by `Early` is still awaiting its POST.
            setTimeout(() => {
                t('LateArrival');
                lateDone();
            }, 30);
            return 'streamed';
        });

        await late;
        await new Promise((r) => setTimeout(r, 200));
        await h.langsys.flush(result);

        const sent = h.registered.flat().map((i) => i.phrase);
        expect(sent).toContain('Early');
        expect(sent).toContain('LateArrival');
    });

    it('POSITIVE CONTROL: a phrase is sent exactly once, not duplicated by the guard', async () => {
        // The opposite failure. A fix that re-sends the whole queue on every drain would
        // satisfy "nothing is lost" while doubling every registration.
        const h = harness();
        const result = await h.langsys.run({ locale: 'it' }, () => {
            t('Once');
            t('Once');
        });
        await settleDrain();
        await h.langsys.flush(result);
        expect(h.registered.flat().filter((i) => i.phrase === 'Once')).toHaveLength(1);
    });
});

describe('WIRE-4 clause 1 — the translation call must never throw', () => {
    /**
     * Checked in rather than left as a scratch measurement. The row cited a dead-port
     * probe that existed only in a session transcript, and CONF-2 is explicit that
     * evidence you cannot re-run is a memory, not a test.
     *
     * `127.0.0.1:1` is a real connection refusal, not a stubbed rejection — the failure
     * arrives through the same path a DNS outage or a down API would take. On the server
     * profile this is an availability coupling rather than a code-quality point: this
     * package sits in the request path, so an unhandled rejection here turns a working
     * page into a 500 for every visitor.
     */
    const deadPort = () =>
        createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale: 'en',
            apiUrl: 'http://127.0.0.1:1/api',
        });

    it('run() + t() degrade to source text instead of throwing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await deadPort().run({ locale: 'it' }, () => t('Hello'));
        expect(res.value).toBe('Hello');
    });

    it('preloadCatalog() degrades instead of throwing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(deadPort().preloadCatalog('it')).resolves.toBeDefined();
    });

    it('and clause 2 holds on the unreachable path too — nothing is queued', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await deadPort().run({ locale: 'it' }, () => {
            for (let i = 0; i < 10; i++) t(`Phrase ${i}`);
        });
        expect(res.missing).toHaveLength(0);
    });

    it('POSITIVE CONTROL: a reachable stub DOES translate, so degrading means something', async () => {
        const h = harness();
        const res = await h.langsys.run({ locale: 'it' }, () => t('Known'));
        expect(res.value).toBe('Conosciuto');
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

describe('REG-7 — one send in flight at a time, per queue', () => {
    /**
     * The spec gives this rule a title and no body, so the server reading is stated rather
     * than assumed: ONE QUEUE never has two sends in flight. This SDK keeps a queue per
     * request, so two concurrent requests to one instance can each have a send in flight —
     * the REG-8 in-flight test depends on exactly that — and the rule is met per queue,
     * which is the unit that can race its own bookkeeping (REG-6).
     */
    it('sends a chunked queue one chunk at a time, never overlapping', async () => {
        const h = harness({ batchLimit: 1, registerDelayMs: 30 });
        await h.langsys.run({ locale: 'it' }, () => {
            t('One');
            t('Two');
            t('Three');
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(h.registerCalls(), 'the queue must actually have been chunked').toBe(3);
        expect(h.maxInFlight()).toBe(1);
    });

    it('a flush() while that queue is still sending waits, rather than overlapping', async () => {
        const h = harness({ registerDelayMs: 60 });
        let lateDone!: () => void;
        const late = new Promise<void>((r) => (lateDone = r));
        const result = await h.langsys.run({ locale: 'it' }, () => {
            t('First');
            // Inside the scope, so it lands on the same queue while First is still in flight.
            setTimeout(() => {
                t('Second');
                lateDone();
            }, 20);
        });
        await late;
        await h.langsys.flush(result); // First is still in flight: this must not send
        await new Promise((r) => setTimeout(r, 150));
        await h.langsys.flush(result); // First has settled: Second goes now
        await new Promise((r) => setTimeout(r, 150));
        expect(h.registered.flat().map((i) => i.phrase)).toEqual(['First', 'Second']);
        expect(h.maxInFlight()).toBe(1);
    });
});

describe('REG-8 — a failed send backs off, per instance', () => {
    /**
     * The backoff half only. REG-8's other half — a failed send STAYS QUEUED — needs state
     * that outlives the request and is held for a spec ruling. So a phrase dropped by a
     * failed or skipped send is not retried; it re-registers the next time it renders
     * after the window.
     *
     * Only `Date` is faked. `setTimeout` and `setImmediate` stay real, because the drain
     * is scheduled on one and the stub's in-flight delay is the other; faking those too
     * would make these tests about the fake.
     */
    const T0 = Date.UTC(2026, 0, 1);
    const at = (ms: number) => vi.setSystemTime(T0 + ms);
    type H = ReturnType<typeof harness>;
    const render = async (h: H, phrase: string) => {
        await h.langsys.run({ locale: 'it' }, () => t(phrase));
        await settleDrain();
    };
    const sent = (h: H) => h.registered.flat().map((i) => i.phrase);
    /** An instance whose first send failed at T0, with the endpoint healthy again. */
    const failedOnce = async () => {
        const h = harness({ registerFails: true });
        at(0);
        await render(h, 'Doomed');
        expect(h.registerCalls(), 'the failing send must actually have gone out').toBe(1);
        h.setRegisterFails(false);
        return h;
    };

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        at(0);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends nothing inside the 3s window after a failed send', async () => {
        const h = await failedOnce();
        at(2_999);
        await render(h, 'TooSoon');
        expect(h.registerCalls()).toBe(1);
        expect(sent(h)).not.toContain('TooSoon');
    });

    it('POSITIVE CONTROL: sends again the moment the window ends', async () => {
        const h = await failedOnce();
        at(3_000);
        await render(h, 'Probe');
        expect(sent(h)).toContain('Probe');
    });

    it('doubles the window on each consecutive failure', async () => {
        const h = harness({ registerFails: true });
        await render(h, 'First'); // fails at 0s -> window to 3s
        at(3_000);
        await render(h, 'Second'); // fails at 3s -> 6s window, nothing until 9s
        expect(h.registerCalls(), 'the second failing send must have gone out').toBe(2);
        h.setRegisterFails(false);
        at(8_999);
        await render(h, 'TooSoon');
        expect(sent(h)).not.toContain('TooSoon');
        at(9_000);
        await render(h, 'OnTime');
        expect(sent(h)).toContain('OnTime');
    });

    it('stops doubling at the 5 minute ceiling', async () => {
        const h = harness({ registerFails: true });
        // 3s * 2^7 would be 384s: the eighth window is the first the ceiling cuts.
        const windows = [3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 192_000, 300_000];
        let now = 0;
        await render(h, 'Fail 1');
        for (let i = 1; i < windows.length; i++) {
            now += windows[i - 1]!;
            at(now);
            await render(h, `Fail ${i + 1}`);
        }
        // Positive evidence that every probe went out exactly when its window ended.
        expect(h.registerCalls()).toBe(windows.length);
        h.setRegisterFails(false);
        at(now + 299_999);
        await render(h, 'Early');
        expect(sent(h)).not.toContain('Early');
        at(now + 300_000);
        await render(h, 'Capped');
        expect(sent(h)).toContain('Capped');
    });

    it('resets to 3s on the first success', async () => {
        const h = await failedOnce();
        at(3_000);
        await render(h, 'Recovered');
        expect(sent(h)).toContain('Recovered');
        h.setRegisterFails(true);
        await render(h, 'FailsAgain'); // a FIRST failure again -> 3s, not 6s
        // Four sends: Doomed, Recovered, Doomed's retained retry on that recovery, FailsAgain.
        expect(h.registerCalls()).toBe(4);
        h.setRegisterFails(false);
        at(5_999);
        await render(h, 'TooSoon');
        expect(sent(h)).not.toContain('TooSoon');
        at(6_000);
        await render(h, 'Back');
        expect(sent(h)).toContain('Back');
    });

    it('a registration that THROWS backs off too', async () => {
        const h = harness();
        h.setRegisterThrows(true);
        await render(h, 'Thrown');
        expect(h.registerCalls()).toBe(1);
        h.setRegisterThrows(false);
        at(2_999);
        await render(h, 'TooSoon');
        expect(h.registerCalls()).toBe(1);
    });

    it('holds on the flush() path too, not only the scheduled drain', async () => {
        const h = await failedOnce();
        at(1_000);
        const result = await h.langsys.run({ locale: 'it' }, () => t('Flushed'));
        await h.langsys.flush(result);
        await settleDrain();
        expect(h.registerCalls()).toBe(1);
    });

    it('is per INSTANCE: one project failing does not throttle another in the same process', async () => {
        // A module-level clock would let one tenant's broken key silence every other
        // tenant's registrations — CACHE-1's shape, for backoff.
        const failing = await failedOnce();
        const healthy = harness();
        at(1_000);
        await render(healthy, 'Tenant B');
        await render(failing, 'Tenant A');
        expect(sent(healthy)).toContain('Tenant B');
        // Positive evidence the window was live at that moment, or B passing means nothing.
        expect(sent(failing)).not.toContain('Tenant A');
    });

    it('sends already in flight when the first one fails count as ONE failure, not two', async () => {
        const h = harness({ registerFails: true, registerDelayMs: 50 });
        await Promise.all([
            h.langsys.run({ locale: 'it' }, () => t('Concurrent A')),
            h.langsys.run({ locale: 'it' }, () => t('Concurrent B')),
        ]);
        await new Promise((r) => setTimeout(r, 150));
        // Two calls proves both left before either failed; a skipped second send is 1.
        expect(h.registerCalls(), 'both sends must have been in flight together').toBe(2);
        h.setRegisterFails(false);
        at(3_000);
        await render(h, 'After');
        // This stub holds every send 50ms and records it only after, so settleDrain's 20ms
        // is not enough here. The first version asserted too early and was red for that
        // reason alone, on code with no backoff at all — a red that proved nothing.
        await new Promise((r) => setTimeout(r, 100));
        expect(sent(h)).toContain('After');
    });

    it('is not silent: warns once per window, saying what was dropped', async () => {
        const warnings = () =>
            vi
                .mocked(console.warn)
                .mock.calls.map((c) => c.join(' '))
                .filter((m) => m.includes('backing off'));
        const h = await failedOnce();
        at(1_000);
        await render(h, 'Skipped 1');
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toMatch(/\b1 phrase/);
        at(2_000);
        await render(h, 'Skipped 2');
        expect(warnings(), 'once per window, not once per render').toHaveLength(1);
        h.setRegisterFails(true);
        at(3_000);
        await render(h, 'Fails again');
        at(4_000);
        await render(h, 'Skipped 3');
        expect(warnings(), 'a NEW window announces itself').toHaveLength(2);
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

describe('WIRE-2 on the drain path — a 204 from registration is a success', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.UTC(2026, 0, 1));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('logs no failure and opens no backoff window', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness();
        h.setRegisterNoContent(true);
        await h.langsys.run({ locale: 'it' }, () => t('Accepted'));
        await settleDrain();
        expect(h.registerCalls(), 'the 204 send must actually have gone out').toBe(1);
        const failures = error.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('Failed to register'));
        expect(failures).toEqual([]);
        // Same instant, so this is inside any window a mistaken failure would have opened.
        await h.langsys.run({ locale: 'it' }, () => t('Next'));
        await settleDrain();
        expect(h.registered.flat().map((i) => i.phrase)).toContain('Next');
    });
});

describe('REG-8 retention — a failed send stays queued on its own request', () => {
    /**
     * Items that did not go out stay on the request that collected them and are sent in that
     * request's own drain once the window ends — here triggered by the next successful send.
     * Never merged into another request's POST, and bounded per server object.
     */
    const T0 = Date.UTC(2026, 0, 1);
    const at = (ms: number) => vi.setSystemTime(T0 + ms);
    type H = ReturnType<typeof harness>;
    const render = async (h: H, ...phrases: string[]) => {
        await h.langsys.run({ locale: 'it' }, () => phrases.forEach((p) => t(p)));
        await settleDrain();
    };
    const posts = (h: H) => h.registered.map((batch) => batch.map((i) => i.phrase));

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        at(0);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('a phrase whose send failed is sent again once the endpoint recovers', async () => {
        const h = harness({ registerFails: true });
        await render(h, 'Doomed');
        h.setRegisterFails(false);
        at(3_000);
        await render(h, 'Probe');
        await settleDrain();
        expect(posts(h).flat().filter((p) => p === 'Doomed')).toHaveLength(2);
    });

    it('a phrase skipped inside the window is sent after it, not dropped', async () => {
        const h = harness({ registerFails: true });
        await render(h, 'Doomed');
        h.setRegisterFails(false);
        at(1_000);
        await render(h, 'Skipped');
        expect(posts(h).flat()).not.toContain('Skipped');
        at(3_000);
        await render(h, 'Probe');
        await settleDrain();
        expect(posts(h).flat()).toContain('Skipped');
    });

    it('retained items ride in their own request\'s send, never in another request\'s', async () => {
        const h = harness({ registerFails: true });
        await render(h, 'Doomed');
        h.setRegisterFails(false);
        at(3_000);
        await render(h, 'Probe');
        await settleDrain();
        expect(posts(h).some((b) => b.includes('Probe') && b.includes('Doomed'))).toBe(false);
    });

    it('is bounded: past the cap the oldest request\'s items are dropped, with a warning', async () => {
        const h = harness({ registerFails: true });
        await render(h, ...Array.from({ length: 1_500 }, (_, i) => `First ${i}`));
        at(1_000);
        await render(h, ...Array.from({ length: 600 }, (_, i) => `Second ${i}`));
        const dropped = vi.mocked(console.warn).mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('Dropped'));
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toMatch(/Dropped 1500 unsent/);
    });

    it('CONTROL: a refused session keeps nothing — discarding what you may not write is correct', async () => {
        const h = harness({ writeEnabled: false });
        await render(h, 'Refused');
        h.setCatalogWriteEnabled(true);
        at(120_000);
        await render(h, 'Later');
        await settleDrain();
        expect(posts(h).flat()).not.toContain('Refused');
    });
});

describe('GATE-2 — an unknown write decision holds, never collapses to refused', () => {
    const T0 = Date.UTC(2026, 0, 1);
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('a phrase seen before authorization answers is sent once it resolves favourably', async () => {
        const h = harness();
        h.setAuthorizeFails(true);
        await h.langsys.run({ locale: 'it' }, () => t('Early'));
        await settleDrain();
        expect(h.registerCalls(), 'nothing may go out while the decision is unknown').toBe(0);
        h.setAuthorizeFails(false);
        vi.setSystemTime(T0 + 60_000);
        await h.langsys.run({ locale: 'it' }, () => t('Later'));
        await settleDrain();
        await settleDrain();
        expect(h.registered.flat().map((i) => i.phrase)).toContain('Early');
    });
});

describe('REG-13 — "unregistered" is decided only against a catalog that has loaded', () => {
    /**
     * Met by construction: `run()` awaits the catalog before the render starts, so no miss is
     * decided while the first read is in flight. Proven with a first read slower than the drain
     * that already holds the phrase — tier `n/a (pure)`, since a duplicate registration is
     * invisible in the server's idempotent state.
     */
    it('a slow first catalog that already holds the phrase produces no registration', async () => {
        const registered: unknown[] = [];
        const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
            const href = String(url);
            if (href.includes('authorize-project')) {
                return new Response(JSON.stringify({ status: true, data: { key_type: 'write' } }), { status: 200 });
            }
            if (href.includes('translatable-items')) {
                registered.push(...JSON.parse(String(init?.body)).translatable_items);
                return new Response(JSON.stringify({ status: true }), { status: 200 });
            }
            await new Promise((r) => setTimeout(r, 150));
            return new Response(JSON.stringify({ status: true, data: { __uncategorized__: { Known: 'Conosciuto' } } }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', fetch: fetchImpl });
        const res = await langsys.run({ locale: 'it' }, () => t('Known'));
        await settleDrain();
        expect(res.value).toBe('Conosciuto');
        expect(registered).toEqual([]);
    });
});
