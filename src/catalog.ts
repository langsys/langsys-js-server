/**
 * Catalog fetching and caching.
 *
 * Server-side rendering does not make translations realtime. It shortens the fuse.
 *
 * The structural rule this file obeys, which `langsys-php` gets for free from PHP-FPM
 * and Node does not:
 *
 *   > Any in-process memo is request-scoped. The shared tier is the ONLY cross-request
 *   > tier. A five-minute process-lived memo sitting in front of a shared cache
 *   > reintroduces exactly the inconsistency the shared cache was added to remove.
 *
 * PHP has not "solved" multi-worker cache inconsistency — it has never had the problem.
 * `Client::$translationsMemoryCache` is an ordinary instance property, and under FPM the
 * object dies with the request, so the shared tier is the only cross-request tier by
 * construction. Run that same code under FrankenPHP worker mode, Swoole or RoadRunner
 * and it has the PM2 bug exactly. Do not read PHP's architecture as a validated answer
 * to a question it has not faced.
 */

import { LangsysApi, readWriteEnabled } from './api.js';
import { canonicalizeLocale } from 'langsys-js-typescript/pure';
import { UNCATEGORIZED } from './constants.js';
import type { Logger } from './logger.js';
import type { Catalog, SharedCache } from './types.js';

interface CachedRecord {
    /**
     * ABSOLUTE epoch milliseconds, stamped at WRITE time into the shared record.
     *
     * Copied from `FileCache::set()`, which writes `time() + $ttl`. Every reader of the
     * key sees the same expiry instant, so workers expire TOGETHER rather than drifting
     * by however long each has been up. A per-process "cached at" clock is what makes
     * propagation staggered; an absolute stamp inside the shared record makes it atomic.
     */
    expiresAt: number;
    catalog: Catalog;
}

export const DEFAULT_TTL_SECONDS = 300;

/** Upper bound on distinct locales held in the process memo. See `rememberInProcess`. */
export const MAX_MEMOIZED_LOCALES = 64;

/**
 * Hand every request its own copy of the catalog.
 *
 * The memo holds one object per locale for the whole TTL, and `run()` returns it as
 * `RenderResult.catalog` — which the README and the example both instruct the integrator
 * to pass onward to a client SDK for seeding. That SDK's `init()` **mutates the object it
 * is given** (it stamps `__category__` into every category and injects
 * `__uncategorized__`), which this file already documents from the other side.
 *
 * Without a copy, one request's post-processing silently rewrites the catalog every
 * subsequent request in the process renders against. Load-dependent, invisible with one
 * user, and only on the default no-shared-cache path — the exact profile this package
 * exists to eliminate. The shared-cache path is already immune because `JSON.parse`
 * yields a fresh object per request; this makes the two paths agree.
 */
function cloneCatalog(catalog: Catalog): Catalog {
    return structuredClone(catalog);
}

export class CatalogStore {
    /**
     * In-flight fetches, keyed by cache key.
     *
     * `langsys-php` has NO single-flight — `get()` takes no lock, so N workers missing
     * the same key simultaneously all call the API. Harmless at PHP-FPM's concurrency;
     * not harmless at Node's, where one process can have hundreds of concurrent renders
     * miss the same key in the same tick. This is the one property of PHP's shared tier
     * deliberately NOT copied.
     */
    private readonly inFlight = new Map<string, Promise<Catalog>>();

    /**
     * Process-lived memo, used ONLY when no shared cache is configured.
     *
     * With a shared tier this stays empty, because a process memo in front of it is
     * exactly the staggered-propagation bug the shared tier exists to remove.
     */
    private readonly processMemo = new Map<string, CachedRecord>();

    /**
     * Per-key invalidation counter. Incremented by `invalidate()` so a fetch that was
     * already in flight cannot write a stale catalog back after the invalidation.
     */
    private readonly generations = new Map<string, number>();

    constructor(
        private readonly api: LangsysApi,
        private readonly logger: Logger,
        private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
        private readonly sharedCache?: SharedCache,
        /**
         * Called with the `write_enabled` carried on a successful catalog response's
         * ENVELOPE.
         *
         * This is how GATE-8's "re-evaluated per response, never latched at init" is
         * actually satisfied: a catalog fetch already happens once per locale per TTL, so
         * the capability is refreshed on a response the SDK was making anyway — no extra
         * round-trip, and a server that gains the field mid-deployment is picked up
         * without an SDK release.
         *
         * Only ever called when the flag is PRESENT. An absent flag here does not erase a
         * positive answer from `authorize()`: absence is a statement about the server's
         * version, and the server that omits it on this endpoint would have omitted it on
         * that one too. Letting absence overwrite `true` would silently close the gate on
         * exactly the `ip_write` key discovery depends on.
         */
        private readonly onCapability?: (writeEnabled: boolean) => void,
    ) {}

    /**
     * CACHE-1: every key carries the project id, plus the locale, which is the only other
     * thing that changes the answer.
     *
     * Without the project id this is invisible until two projects share a backing store —
     * and then it is not a subtle bug: the second project's visitors are served the
     * first's copy for a full TTL, fleet-wide on shared Redis. The process memo hides it,
     * because that is an instance field; it takes the shared tier to surface, which is
     * precisely the deployment the shared tier exists for.
     *
     * Read off `api.projectId` rather than taking a second constructor argument, so the
     * id in the key cannot drift from the id on the wire.
     */
    private key(locale: string): string {
        return `langsys:catalog:${this.api.projectId}:${canonicalizeLocale(locale)}`;
    }

    async get(locale: string): Promise<Catalog> {
        const key = this.key(locale);
        const now = Date.now();

        if (this.sharedCache) {
            // The READ is guarded, not just the parse. A `cache` adapter is user code
            // talking to a network service: `redis.get()` rejects when the connection
            // drops. Unguarded, that rejection propagates out of `run()` and through the
            // host's `handle` hook, so **every SSR request on every worker 500s until
            // Redis comes back** — the cache tier becomes a hard availability dependency
            // of page rendering.
            //
            // The correct degraded behaviour is the one this package applies everywhere
            // else: log loudly and fall through to the API. A translation problem must
            // not become an outage.
            let raw: string | null = null;
            try {
                raw = await this.sharedCache.get(key);
            } catch (err) {
                this.logger.error(
                    `Shared cache read failed for "${locale}"; falling through to the API. ` +
                        'Rendering is unaffected, but every request is now paying a fetch.',
                    err,
                );
            }

            if (raw) {
                try {
                    const record = JSON.parse(raw) as CachedRecord;
                    // No clone needed here: JSON.parse already yields a fresh object per
                    // request, which is what makes this path immune to the aliasing the
                    // process-memo path has to defend against below.
                    if (record.expiresAt > now) return record.catalog;
                } catch (err) {
                    // A corrupt record must not take the page down, but it must not be
                    // silent either — silent cache corruption presents as "translations
                    // randomly stop working".
                    this.logger.error(`Discarding unparseable cached catalog for ${locale}`, err);
                }
            }
        } else {
            const record = this.processMemo.get(key);
            if (record && record.expiresAt > now) return cloneCatalog(record.catalog);

            this.logger.warnOnce('no-shared-cache',
                'No shared cache is configured, so each worker holds an independent catalog. ' +
                    'During propagation the same URL can alternate between old and new copy ' +
                    'depending on which worker answers — which reads to a non-engineer as ' +
                    '"my change did not save". Pass `cache` to createLangsysServer() in any ' +
                    'multi-worker deployment. See README "Caching and freshness".',
            );
        }

        // Single-flight: coalesce concurrent misses for the same key.
        const existing = this.inFlight.get(key);
        if (existing) return cloneCatalog(await existing);

        // Stamp the generation this fetch started in. `invalidate()` bumps it, so a fetch
        // already on the wire when an invalidation lands is not allowed to write its
        // now-stale result back into the cache. Without this the explicit invalidation is
        // silently undone and the site serves pre-edit copy for a full TTL — which is
        // exactly the "my change didn't save" this file exists to prevent, arriving from
        // the one direction the TTL cannot help with.
        const generation = this.generations.get(key) ?? 0;

        const promise = this.fetchAndStore(locale, key, generation)
            .finally(() => this.inFlight.delete(key));

        this.inFlight.set(key, promise);
        return cloneCatalog(await promise);
    }

    private async fetchAndStore(locale: string, key: string, generation: number): Promise<Catalog> {
        let catalog: Catalog = {};
        try {
            const response = await this.api.getTranslations(locale);
            if (response.status && response.data) {
                // Read the capability off the ENVELOPE before anything is cached, and
                // cache only the body. That ordering is GATE-4 for this endpoint: the
                // flag describes the session, the body describes the project, and only
                // the second may outlive the request.
                const capability = readWriteEnabled(response);
                if (capability !== undefined) this.onCapability?.(capability);

                catalog = normalizeCatalog(response.data);
            } else {
                // Fire-and-forget on the harvest side, but NOT here: a failed catalog
                // fetch means the whole page renders base language, which is the exact
                // defect this package exists to correct. It must produce a signal.
                this.logger.error(`Catalog fetch for "${locale}" failed`, response.errors);
                return {};
            }
        } catch (err) {
            this.logger.error(`Catalog fetch for "${locale}" threw`, err);
            return {};
        }

        // An invalidation landed while this fetch was on the wire. The result is
        // already stale, so serve it to THIS request (it is what the API said) but do
        // not write it back — re-seeding here would undo the invalidation for a full TTL.
        if ((this.generations.get(key) ?? 0) !== generation) {
            this.logger.log(
                `Discarding cache write for "${locale}": invalidated while the fetch was in flight.`,
            );
            return catalog;
        }

        const record: CachedRecord = {
            expiresAt: Date.now() + this.ttlSeconds * 1000,
            catalog,
        };

        try {
            if (this.sharedCache) {
                await this.sharedCache.set(key, JSON.stringify(record), this.ttlSeconds);
            } else {
                this.rememberInProcess(key, record);
            }
        } catch (err) {
            // A cache write failure degrades performance, not correctness.
            this.logger.error(`Could not cache catalog for "${locale}"`, err);
        }

        return catalog;
    }

    /**
     * Write to the process memo, bounded.
     *
     * The locale reaching `run()` is frequently derived from the URL, and nothing in this
     * package requires the host to validate it against an allowlist (the example does;
     * the README does not demand it). If the API answers an unknown locale with
     * `{status: true, data: {}}` rather than a failure, an unbounded memo pins one entry
     * per distinct request-supplied string for the life of the process.
     *
     * A `Map` preserves insertion order, so evicting the oldest key is a one-liner and
     * costs nothing in the normal case where an app serves a handful of locales.
     */
    private rememberInProcess(key: string, record: CachedRecord): void {
        this.processMemo.delete(key);
        this.processMemo.set(key, record);
        while (this.processMemo.size > MAX_MEMOIZED_LOCALES) {
            const oldest = this.processMemo.keys().next().value;
            if (oldest === undefined) break;
            this.processMemo.delete(oldest);
        }
    }

    /**
     * Drop a locale's cached catalog. Targets the SHARED key, so one worker's
     * invalidation is every worker's — mirroring `Client::clearCache()`.
     */
    async invalidate(locale: string): Promise<void> {
        const key = this.key(locale);

        // Bump FIRST, so a fetch already on the wire sees a changed generation when it
        // lands and declines to write itself back.
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
        this.inFlight.delete(key);
        this.processMemo.delete(key);

        if (!this.sharedCache) return;
        try {
            await this.sharedCache.delete(key);
        } catch (err) {
            // Same reasoning as the read path: a cache adapter is user code talking to a
            // network service, and an invalidation failing must not throw into whatever
            // called it (typically a webhook handler).
            this.logger.error(`Shared cache delete failed for "${locale}"`, err);
        }
    }
}

/**
 * Stamp `__category__` into each category and ensure `__uncategorized__` exists.
 *
 * This is the same shape obligation the client SDK's `init()` performs when seeding
 * (`dist/index.mjs:784-791`). `__category__` is a required field of `iTranslations` but
 * no runtime code branches on its value — it is written in four places and read in none
 * — so this is a shape obligation, not a behavioural one. Doing it here means a catalog
 * handed to a client SDK for seeding is already correctly shaped.
 *
 * Unlike `init()`, this does NOT mutate its argument. `init()` writes into the object
 * you pass it, which is the framework's server payload.
 */
export function normalizeCatalog(input: Catalog): Catalog {
    const out: Catalog = {};
    for (const [name, category] of Object.entries(input)) {
        out[name] = { ...category, __category__: name, __symbol__: name };
    }
    if (!out[UNCATEGORIZED]) {
        out[UNCATEGORIZED] = { __category__: UNCATEGORIZED, __symbol__: UNCATEGORIZED };
    }
    return out;
}
