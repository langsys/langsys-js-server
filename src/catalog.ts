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

import { LangsysApi } from './api.js';
import { canonicalizeLocale } from './vendor/pure.js';
import { UNCATEGORIZED } from './constants.js';
import { warnOnce, type Logger } from './logger.js';
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

    constructor(
        private readonly api: LangsysApi,
        private readonly logger: Logger,
        private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
        private readonly sharedCache?: SharedCache,
    ) {}

    private key(locale: string): string {
        return `langsys:catalog:${canonicalizeLocale(locale)}`;
    }

    async get(locale: string): Promise<Catalog> {
        const key = this.key(locale);
        const now = Date.now();

        if (this.sharedCache) {
            const raw = await this.sharedCache.get(key);
            if (raw) {
                try {
                    const record = JSON.parse(raw) as CachedRecord;
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
            if (record && record.expiresAt > now) return record.catalog;

            warnOnce(
                this.logger,
                'no-shared-cache',
                'No shared cache is configured, so each worker holds an independent catalog. ' +
                    'During propagation the same URL can alternate between old and new copy ' +
                    'depending on which worker answers — which reads to a non-engineer as ' +
                    '"my change did not save". Pass `cache` to createLangsysServer() in any ' +
                    'multi-worker deployment. See README "Caching and freshness".',
            );
        }

        // Single-flight: coalesce concurrent misses for the same key.
        const existing = this.inFlight.get(key);
        if (existing) return existing;

        const promise = this.fetchAndStore(locale, key)
            .finally(() => this.inFlight.delete(key));

        this.inFlight.set(key, promise);
        return promise;
    }

    private async fetchAndStore(locale: string, key: string): Promise<Catalog> {
        let catalog: Catalog = {};
        try {
            const response = await this.api.getTranslations(locale);
            if (response.status && response.data) {
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

        const record: CachedRecord = {
            expiresAt: Date.now() + this.ttlSeconds * 1000,
            catalog,
        };

        try {
            if (this.sharedCache) {
                await this.sharedCache.set(key, JSON.stringify(record), this.ttlSeconds);
            } else {
                this.processMemo.set(key, record);
            }
        } catch (err) {
            // A cache write failure degrades performance, not correctness.
            this.logger.error(`Could not cache catalog for "${locale}"`, err);
        }

        return catalog;
    }

    /**
     * Drop a locale's cached catalog. Targets the SHARED key, so one worker's
     * invalidation is every worker's — mirroring `Client::clearCache()`.
     */
    async invalidate(locale: string): Promise<void> {
        const key = this.key(locale);
        this.processMemo.delete(key);
        if (this.sharedCache) await this.sharedCache.delete(key);
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
