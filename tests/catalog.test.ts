/**
 * `CatalogStore`.
 *
 * Before this file, **21 of 24 mutations to `catalog.ts` survived** — no test ever passed
 * a `cache` adapter, so every shared-cache branch was dead to the suite. Mutations that
 * kept it green included: the shared cache never expiring, `catalogTtlSeconds` being
 * ignored, `invalidate()` becoming a no-op, nothing ever being cached, and putting the
 * process memo IN FRONT of the shared cache — which is the PM2 staggered-propagation bug
 * this file's header exists to prevent.
 *
 * All of it presents to a human as "my change didn't save".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore, normalizeCatalog, MAX_MEMOIZED_LOCALES } from '../src/catalog.js';
import { LangsysApi } from '../src/api.js';
import { createLogger } from '../src/logger.js';
import type { Catalog, SharedCache } from '../src/types.js';

/** A `SharedCache` backed by a Map, with counters so behaviour can be asserted. */
function makeSharedCache() {
    const store = new Map<string, string>();
    const calls = { get: 0, set: 0, delete: 0 };
    let failGet: Error | null = null;
    let failSet: Error | null = null;
    let failDelete: Error | null = null;

    const cache: SharedCache = {
        get(key) {
            calls.get++;
            if (failGet) throw failGet;
            return store.get(key) ?? null;
        },
        set(key, value) {
            calls.set++;
            if (failSet) throw failSet;
            store.set(key, value);
        },
        delete(key) {
            calls.delete++;
            if (failDelete) throw failDelete;
            store.delete(key);
        },
    };

    return {
        cache,
        store,
        calls,
        breakGet: (e: Error) => (failGet = e),
        breakSet: (e: Error) => (failSet = e),
        breakDelete: (e: Error) => (failDelete = e),
    };
}

const CATALOG: Catalog = { __uncategorized__: { Hello: 'Ciao' } };

/**
 * What `get()` actually returns: the fetched catalog put through `normalizeCatalog`, so
 * `__category__`/`__symbol__` are stamped. Compared against here rather than against the
 * raw fixture, because the normalization is a real obligation to the client SDK's
 * `iTranslations` shape and asserting the un-normalized form would quietly permit
 * dropping it.
 */
const NORMALIZED = normalizeCatalog(CATALOG);

function makeApi(
    opts: {
        catalog?: Catalog;
        status?: boolean;
        delayMs?: number;
        throws?: boolean;
        projectId?: string | number;
    } = {},
) {
    const fetches: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
        const href = String(url);
        fetches.push(href);
        if (opts.throws) throw new Error('network down');
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return new Response(
            JSON.stringify({ status: opts.status ?? true, data: opts.catalog ?? CATALOG }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as unknown as typeof globalThis.fetch;

    return {
        api: new LangsysApi(opts.projectId ?? 'p', 'k', 'https://example.test/api', fetchImpl),
        fetches,
    };
}

const logger = () => createLogger(false);

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the harness itself', () => {
    it('fetches and returns a catalog, or nothing below means anything', async () => {
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300);
        expect((await store.get('it')).catalog).toEqual(NORMALIZED);
        expect(fetches).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('CACHE-1 — keys are namespaced by project', () => {
    /**
     * The spec's own framing: "an unnamespaced key is invisible until two projects share
     * a backing store." Nothing in-process catches this, because the process memo is an
     * instance field — it takes the shared tier, which is the deployment the shared tier
     * exists for. Measured against 0.1.0: project B was served project A's catalog.
     *
     * A wrong value cached in a browser harms one user. The same value cached here is
     * served to every visitor of the wrong tenant until the TTL expires — and it does not
     * look like a bug, it looks like someone else's copy.
     */
    const ALPHA: Catalog = { __uncategorized__: { Hello: 'ALPHA-COPY' } };
    const BETA: Catalog = { __uncategorized__: { Hello: 'BETA-COPY' } };

    it('does not serve one project the other\'s catalog through a shared cache', async () => {
        const shared = makeSharedCache();
        const a = makeApi({ projectId: 'alpha', catalog: ALPHA });
        const b = makeApi({ projectId: 'beta', catalog: BETA });
        const storeA = new CatalogStore(a.api, logger(), 300, shared.cache);
        const storeB = new CatalogStore(b.api, logger(), 300, shared.cache);

        await storeA.get('it');
        const fromB = (await storeB.get('it')).catalog;

        // Both halves matter. The value assertion is the user-visible harm; the fetch
        // assertion is what proves B actually went to the API rather than being handed a
        // cache hit that happened to look right.
        expect(fromB).toEqual(normalizeCatalog(BETA));
        expect(b.fetches).toHaveLength(1);
    });

    it('writes a key carrying the project id', async () => {
        const shared = makeSharedCache();
        const { api } = makeApi({ projectId: 'alpha' });
        await new CatalogStore(api, logger(), 300, shared.cache).get('it');

        const keys = [...shared.store.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toContain('alpha');
    });

    it('POSITIVE CONTROL: one project still reads its OWN cached catalog', async () => {
        // Without this, "B fetched its own" is satisfiable by a key so unique that
        // nothing ever hits the cache at all — which would pass the test above while
        // silently disabling the shared tier.
        const shared = makeSharedCache();
        const { api, fetches } = makeApi({ projectId: 'alpha', catalog: ALPHA });
        const store = new CatalogStore(api, logger(), 300, shared.cache);

        await store.get('it');
        const second = (await store.get('it')).catalog;

        expect(second).toEqual(normalizeCatalog(ALPHA));
        expect(fetches).toHaveLength(1);
    });

    it('separates two projects that share a locale AND a cache, in both directions', async () => {
        const shared = makeSharedCache();
        const a = makeApi({ projectId: 1, catalog: ALPHA });
        const b = makeApi({ projectId: 2, catalog: BETA });
        const storeA = new CatalogStore(a.api, logger(), 300, shared.cache);
        const storeB = new CatalogStore(b.api, logger(), 300, shared.cache);

        // B first this time: a fix that only namespaces on write would pass one order
        // and fail the other.
        expect((await storeB.get('it')).catalog).toEqual(normalizeCatalog(BETA));
        expect((await storeA.get('it')).catalog).toEqual(normalizeCatalog(ALPHA));
        expect(shared.store.size).toBe(2);
    });

    it('invalidate() drops only the calling project\'s entry', async () => {
        const shared = makeSharedCache();
        const a = makeApi({ projectId: 'alpha', catalog: ALPHA });
        const b = makeApi({ projectId: 'beta', catalog: BETA });
        const storeA = new CatalogStore(a.api, logger(), 300, shared.cache);
        const storeB = new CatalogStore(b.api, logger(), 300, shared.cache);

        await storeA.get('it');
        await storeB.get('it');
        await storeA.invalidate('it');

        // A re-fetches, B does not: the invalidation was scoped to A.
        await storeA.get('it');
        await storeB.get('it');
        expect(a.fetches).toHaveLength(2);
        expect(b.fetches).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('expiry is absolute and stamped at write time', () => {
    it('serves from cache while fresh', async () => {
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300);
        await store.get('it');
        await store.get('it');
        expect(fetches).toHaveLength(1);
    });

    it('re-fetches once the stamped expiry has passed', async () => {
        // Mutation "if (record.expiresAt > now) -> always return" survived before this:
        // the cache would never expire and translations would never update.
        vi.useFakeTimers();
        try {
            const { api, fetches } = makeApi();
            const store = new CatalogStore(api, logger(), 60);
            await store.get('it');
            vi.setSystemTime(Date.now() + 61_000);
            await store.get('it');
            expect(fetches).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('honours catalogTtlSeconds rather than a hardcoded value', async () => {
        vi.useFakeTimers();
        try {
            const { api, fetches } = makeApi();
            const store = new CatalogStore(api, logger(), 3600);
            await store.get('it');
            vi.setSystemTime(Date.now() + 600_000); // 10 min — past 300s, inside 3600s
            await store.get('it');
            expect(fetches).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('writes an absolute expiry into the SHARED record, so workers expire together', async () => {
        const shared = makeSharedCache();
        const { api } = makeApi();
        const before = Date.now();
        await new CatalogStore(api, logger(), 120, shared.cache).get('it');

        const [raw] = [...shared.store.values()];
        const record = JSON.parse(raw) as { expiresAt: number };
        // A per-process "cached at" clock is what makes propagation staggered. An
        // absolute instant inside the shared record is what makes it atomic.
        expect(record.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
        expect(record.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    });

    it('a second worker reading the shared record inherits its expiry', async () => {
        vi.useFakeTimers();
        try {
            const shared = makeSharedCache();
            const a = makeApi();
            const b = makeApi();
            await new CatalogStore(a.api, logger(), 60, shared.cache).get('it');

            // Worker B starts later but must expire at the SAME instant as A, not 60s
            // from its own first read.
            vi.setSystemTime(Date.now() + 50_000);
            const storeB = new CatalogStore(b.api, logger(), 60, shared.cache);
            await storeB.get('it');
            expect(b.fetches, 'worker B should have used the shared record').toHaveLength(0);

            vi.setSystemTime(Date.now() + 11_000);
            await storeB.get('it');
            expect(b.fetches, 'worker B should expire with A, not 60s after its own read').toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
describe('the shared tier is the ONLY cross-request tier', () => {
    it('reads the shared cache rather than a process memo', async () => {
        const shared = makeSharedCache();
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);

        await store.get('it');
        await store.get('it');

        expect(fetches).toHaveLength(1);
        // Two reads of the shared tier, not one read plus a memo hit. A process memo in
        // front of the shared cache reintroduces exactly the inconsistency the shared
        // cache was added to remove.
        expect(shared.calls.get).toBe(2);
    });

    it('an external write to the shared cache is picked up immediately', async () => {
        // The strongest form of the above: if a process memo were consulted first, this
        // worker would keep serving the old copy for the whole TTL.
        const shared = makeSharedCache();
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);

        await store.get('it');
        const [key] = [...shared.store.keys()];
        shared.store.set(
            key,
            JSON.stringify({
                expiresAt: Date.now() + 300_000,
                catalog: { __uncategorized__: { Hello: 'UPDATED' } },
            }),
        );

        const got = (await store.get('it')).catalog;
        expect(got.__uncategorized__.Hello).toBe('UPDATED');
    });
});

// ---------------------------------------------------------------------------
describe('a broken cache adapter must not take the site down', () => {
    it('falls through to the API when the shared READ throws', async () => {
        // Unguarded, `redis.get()` rejecting propagated out of run() and 500'd every SSR
        // request on every worker until Redis came back — the cache tier becoming a hard
        // availability dependency of page rendering.
        const shared = makeSharedCache();
        shared.breakGet(new Error('ECONNREFUSED redis'));
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);

        expect((await store.get('it')).catalog).toEqual(NORMALIZED);
        expect(fetches).toHaveLength(1);
        expect(console.error).toHaveBeenCalled();
    });

    it('still renders when the shared WRITE throws', async () => {
        const shared = makeSharedCache();
        shared.breakSet(new Error('redis OOM'));
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);

        expect((await store.get('it')).catalog).toEqual(NORMALIZED);
        expect(console.error).toHaveBeenCalled();
    });

    it('does not throw when the shared DELETE throws', async () => {
        const shared = makeSharedCache();
        shared.breakDelete(new Error('redis gone'));
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);
        await store.get('it');

        // invalidate() is typically called from a webhook handler.
        await expect(store.invalidate('it')).resolves.toBeUndefined();
        expect(console.error).toHaveBeenCalled();
    });

    it('discards an unparseable cached record, loudly', async () => {
        const shared = makeSharedCache();
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);
        await store.get('it');
        const [key] = [...shared.store.keys()];
        shared.store.set(key, 'not json');

        expect((await store.get('it')).catalog).toEqual(NORMALIZED);
        expect(fetches).toHaveLength(2);
        expect(console.error).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('a failed fetch is not cached and is not silent', () => {
    it('does not cache a status:false response', async () => {
        // `if (response.status && response.data)` -> `if (response.data)` survived: a
        // `{status:false, data:{}}` body was cached as a valid empty catalog, so every
        // page rendered base language for a full TTL.
        // CACHE-2 skips the API for 3s after a failure, so the second fetch is taken past that
        // window and well inside the 300s TTL: a failure memoized as a catalog would serve the
        // empty catalog here without fetching.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const { api, fetches } = makeApi({ status: false, catalog: {} });
            const store = new CatalogStore(api, logger(), 300);

            expect((await store.get('it')).ok).toBe(false);
            vi.setSystemTime(Date.now() + 3_000);
            expect((await store.get('it')).ok).toBe(false);
            expect(fetches, 'a failed fetch must not be memoized as a valid catalog').toHaveLength(2);
            expect(console.error).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('logs when the fetch throws, rather than rendering base language silently', async () => {
        const { api } = makeApi({ throws: true });
        const store = new CatalogStore(api, logger(), 300);

        expect((await store.get('it')).catalog).toEqual({});
        expect(console.error).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('single-flight', () => {
    it('coalesces concurrent misses into one upstream fetch', async () => {
        const { api, fetches } = makeApi({ delayMs: 30 });
        const store = new CatalogStore(api, logger(), 300);

        const settled = await Promise.all(Array.from({ length: 25 }, () => store.get('it')));
        const results = settled.map((r) => r.catalog);

        expect(fetches).toHaveLength(1);
        for (const r of results) expect(r).toEqual(NORMALIZED);
    });

    it('does not coalesce ACROSS locales', async () => {
        const { api, fetches } = makeApi({ delayMs: 20 });
        const store = new CatalogStore(api, logger(), 300);
        await Promise.all([store.get('it'), store.get('de'), store.get('fr')]);
        expect(fetches).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
describe('every caller gets its own catalog object', () => {
    it('does not alias the memoized object between requests', async () => {
        // The client SDK's `init()` MUTATES the catalog it is handed, and this package
        // documents that. Without a copy, one request's post-processing silently rewrote
        // the catalog every later request in the process rendered against.
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300);

        const first = (await store.get('it')).catalog;
        const second = (await store.get('it')).catalog;
        expect(first).not.toBe(second);

        (first.__uncategorized__ as Record<string, string>).Hello = 'MUTATED';

        const third = (await store.get('it')).catalog;
        expect(third.__uncategorized__.Hello).toBe('Ciao');
    });

    it('does not alias between concurrent single-flight callers either', async () => {
        const { api } = makeApi({ delayMs: 20 });
        const store = new CatalogStore(api, logger(), 300);
        const [ra, rb] = await Promise.all([store.get('it'), store.get('it')]);
        const a = ra.catalog;
        const b = rb.catalog;

        expect(a).not.toBe(b);
        (a.__uncategorized__ as Record<string, string>).Hello = 'MUTATED';
        expect(b.__uncategorized__.Hello).toBe('Ciao');
    });
});

// ---------------------------------------------------------------------------
describe('the ok flag distinguishes empty-because-failed from empty-because-empty', () => {
    /**
     * An empty catalog means two opposite things and they are identical by shape: a
     * project with nothing to translate, or a fetch that failed. WIRE-4 clause 2 turns on
     * telling them apart — `t()` may only register a miss when the catalog is a real
     * answer, because otherwise every phrase on the page looks new and an outage becomes
     * a write storm against the API that is already failing.
     */
    it('reports ok:false when the fetch fails', async () => {
        const { api } = makeApi({ status: false });
        expect((await new CatalogStore(api, logger(), 300).get('it')).ok).toBe(false);
    });

    it('reports ok:false when the fetch throws', async () => {
        const { api } = makeApi({ throws: true });
        expect((await new CatalogStore(api, logger(), 300).get('it')).ok).toBe(false);
    });

    it('reports ok:true for a GENUINELY EMPTY catalog — the case that must not be confused', async () => {
        // The discriminating vector. A project with no translations yet answers 200 with
        // an empty body; that is an answer, and its misses are real misses that must
        // still register. Conflating it with a failure would silently disable harvesting
        // for exactly the projects that need it most — brand new ones.
        const { api } = makeApi({ catalog: {} });
        const result = await new CatalogStore(api, logger(), 300).get('it');
        expect(result.ok).toBe(true);
        expect(result.catalog).toEqual(normalizeCatalog({}));
    });

    it('reports ok:true from the cache and from the process memo', async () => {
        const shared = makeSharedCache();
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);
        await store.get('it');
        expect((await store.get('it')).ok).toBe(true);

        const memo = new CatalogStore(makeApi().api, logger(), 300);
        await memo.get('it');
        expect((await memo.get('it')).ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe('invalidate()', () => {
    it('forces a re-fetch on the process-memo path', async () => {
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300);
        await store.get('it');
        await store.invalidate('it');
        await store.get('it');
        expect(fetches).toHaveLength(2);
    });

    it('deletes the SHARED key, so one worker invalidation is every worker', async () => {
        const shared = makeSharedCache();
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300, shared.cache);
        await store.get('it');
        expect(shared.store.size).toBe(1);

        await store.invalidate('it');
        expect(shared.store.size).toBe(0);
        expect(shared.calls.delete).toBe(1);
    });

    it('is not undone by a fetch that was already in flight', async () => {
        // The invalidation lands while a pre-edit fetch is on the wire. Without a
        // generation guard that fetch completes afterwards and re-seeds the cache with
        // stale content for a full TTL — the explicit invalidation silently reverted.
        const { api, fetches } = makeApi({ delayMs: 40 });
        const store = new CatalogStore(api, logger(), 300);

        const inFlight = store.get('it');
        await new Promise((r) => setTimeout(r, 10));
        await store.invalidate('it');
        await inFlight;

        await store.get('it');
        expect(fetches, 'the stale in-flight fetch re-seeded the cache').toHaveLength(2);
    });

    it('does not re-seed the SHARED cache from an in-flight fetch either', async () => {
        const shared = makeSharedCache();
        const { api } = makeApi({ delayMs: 40 });
        const store = new CatalogStore(api, logger(), 300, shared.cache);

        const inFlight = store.get('it');
        await new Promise((r) => setTimeout(r, 10));
        await store.invalidate('it');
        await inFlight;

        expect(shared.store.size, 'the shared key was re-populated by a stale fetch').toBe(0);
    });

    it('only affects the locale named', async () => {
        const { api, fetches } = makeApi();
        const store = new CatalogStore(api, logger(), 300);
        await store.get('it');
        await store.get('de');
        await store.invalidate('it');
        await store.get('de');
        expect(fetches).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
describe('the process memo is bounded', () => {
    it('evicts the oldest entry past the cap', async () => {
        // The locale is frequently request-derived and nothing in the package requires
        // the host to validate it. An unbounded memo pins one entry per distinct string
        // for the life of the process.
        const { api } = makeApi();
        const store = new CatalogStore(api, logger(), 300);

        for (let i = 0; i < MAX_MEMOIZED_LOCALES + 10; i++) {
            await store.get(`qa-x-junk${i}`);
        }

        const memo = (store as unknown as { processMemo: Map<string, unknown> }).processMemo;
        expect(memo.size).toBeLessThanOrEqual(MAX_MEMOIZED_LOCALES);
    });
});

// ---------------------------------------------------------------------------
describe('normalizeCatalog', () => {
    it('stamps __category__ and __symbol__ into every category', () => {
        const out = normalizeCatalog({ marketing: { Hello: 'Ciao' } });
        expect(out.marketing.__category__).toBe('marketing');
        expect(out.marketing.__symbol__).toBe('marketing');
        expect(out.marketing.Hello).toBe('Ciao');
    });

    it('injects __uncategorized__ when absent', () => {
        // A shape obligation of the client SDK's `iTranslations`. Dropping it broke
        // seeding, and no test noticed.
        expect(normalizeCatalog({ marketing: {} }).__uncategorized__).toBeTruthy();
    });

    it('does NOT mutate its argument', () => {
        // The client SDK's `init()` writes into the object you pass it. This package
        // deliberately does not repeat that.
        const input: Catalog = { marketing: { Hello: 'Ciao' } };
        normalizeCatalog(input);
        expect(input.marketing.__category__).toBeUndefined();
        expect(input.__uncategorized__).toBeUndefined();
    });
});
