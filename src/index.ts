/**
 * langsys-js-server — request-scoped server-side translation.
 *
 * This module has NO module-level mutable state. Nothing here is written after import,
 * and no value that differs between two concurrent requests lives outside the
 * `AsyncLocalStorage` scope. That is the whole reason this package exists separately
 * from the client SDKs, and it is a property to preserve rather than a style preference:
 * under a long-lived server one process serves every concurrent request, so a single
 * shared mutable field is a cross-request data race that cannot reproduce in development
 * with one user.
 */

import { LangsysApi, DEFAULT_API_URL } from './api.js';
import { CatalogStore, DEFAULT_TTL_SECONDS, normalizeCatalog } from './catalog.js';
import { runInScope, type RequestScope } from './context.js';
import { drainMissQueue, scheduleDrain } from './harvest.js';
import { createLogger } from './logger.js';
import { canonicalizeLocale } from './vendor/pure.js';
import type {
    Catalog,
    KeyType,
    LangsysServerConfig,
    MissingPhrase,
    RequestScopeOptions,
} from './types.js';

export { t, type TFunction } from './translator.js';
export { tokenizeHtml, isPhraseMarked, isTranslationExcluded, type TokenizeOptions } from './tokenizer.js';
export { deriveBlockIdentity, type BlockIdentity, type Derivation } from './derivations.js';
export { generateCustomId, generateLegacyCustomId, interpolate, canonicalizeLocale } from './vendor/pure.js';
export {
    TRANSLATABLE_ATTRIBUTES,
    PHRASE_MARKER_ATTRS,
    PHRASE_MARKER_ATTRS_EMIT,
    SKIP_ELEMENTS,
    UNCATEGORIZED,
} from './constants.js';
export { normalizeCatalog } from './catalog.js';
export { auditRenderedHtml, type AuditFinding, type AuditResult, type AuditOptions } from './audit.js';
export type { Logger } from './logger.js';
export type {
    Catalog,
    CatalogCategory,
    KeyType,
    LangsysServerConfig,
    MissingPhrase,
    RequestScopeOptions,
    SharedCache,
    TranslateParams,
} from './types.js';

/**
 * Internal handle back to the request scope a `RenderResult` came from.
 *
 * `flush()` must drain THE SCOPE THAT RENDERED, not a reconstruction of it. Building a
 * fresh scope from the public fields gave it a fresh `drained` latch, so the documented
 * Workers path — `run()` then `ctx.waitUntil(flush(result))` — POSTed the identical queue
 * twice: once from `flush()`, and again microseconds later from the drain `run()` had
 * already scheduled.
 */
const SCOPE = Symbol('langsys.scope');

/**
 * How long to wait before retrying a failed project authorization.
 *
 * Authorize sits in front of TTFB. Retrying on every request turns a backend problem
 * into a site-wide latency problem — the inverse of the rule that a slow translation
 * backend must never make the site slow.
 */
const AUTHORIZE_RETRY_MS = 60_000;

export interface RenderResult<T> {
    value: T;
    /** The catalog this render used. Hand it to a client SDK to seed hydration. */
    catalog: Catalog;
    locale: string;
    /**
     * Phrases this render could not resolve.
     *
     * This is a LIVE view of the request's queue, not a snapshot — a streamed response
     * can still append to it after `run()` resolves. Copy it if you intend to hold it.
     */
    missing: MissingPhrase[];
    /** @internal */
    [SCOPE]?: RequestScope;
}

export class LangsysServer {
    private readonly api: LangsysApi;
    private readonly catalogs: CatalogStore;
    private readonly logger: ReturnType<typeof createLogger>;
    private readonly baseLocale: string;
    private readonly harvestEnabled: boolean;
    private readonly projectId: string | number;

    /**
     * Key type is discovered from the authorize response, not configured, so "is this a
     * write key" is knowable before any registration attempt.
     *
     * This is the one piece of instance state that is written after construction. It is
     * safe because it is a property of the API KEY, not of a request — every request on
     * this instance uses the same key, so there is nothing to race on. Stated explicitly
     * because "an instance field that is written once" is precisely the shape that turns
     * out to be per-request state in disguise.
     */
    private keyType: KeyType = 'unknown';
    private authorizing?: Promise<void>;
    /**
     * When the last authorize attempt completed, successful or not.
     *
     * Latching only on success meant that a bad key, a deleted project, an HTTP 5xx, or
     * simply an unrecognised `key_type` left `keyType === 'unknown'` — so every single
     * render `await`ed a fresh authorize round-trip, in front of TTFB, forever. The retry
     * window keeps a transient failure recoverable without hammering the API once per
     * request.
     */
    private lastAuthorizeAt = 0;

    constructor(config: LangsysServerConfig) {
        if (!config.projectId) throw new Error('createLangsysServer: `projectId` is required');
        if (!config.apiKey) throw new Error('createLangsysServer: `apiKey` is required');
        if (!config.baseLocale) throw new Error('createLangsysServer: `baseLocale` is required');

        this.projectId = config.projectId;
        this.baseLocale = canonicalizeLocale(config.baseLocale);
        this.harvestEnabled = config.harvest ?? true;
        this.logger = createLogger(config.debug ?? false);
        this.api = new LangsysApi(
            config.projectId,
            config.apiKey,
            config.apiUrl ?? DEFAULT_API_URL,
            config.fetch,
        );
        this.catalogs = new CatalogStore(
            this.api,
            this.logger,
            config.catalogTtlSeconds ?? DEFAULT_TTL_SECONDS,
            config.cache,
        );
    }

    /**
     * Authorize once per process, coalescing concurrent callers.
     *
     * On failure this does NOT retry on the next request — it retries after
     * `AUTHORIZE_RETRY_MS`. An authorize call sits in front of TTFB, so retrying
     * per-request turns a backend problem into a site-wide latency problem, which is the
     * inverse of this package's stated rule that a slow translation backend must never
     * make the site slow.
     */
    private async ensureAuthorized(): Promise<void> {
        if (this.keyType !== 'unknown') return;
        if (this.lastAuthorizeAt && Date.now() - this.lastAuthorizeAt < AUTHORIZE_RETRY_MS) return;

        this.authorizing ??= this.api
            .authorize()
            .then(({ status, keyType }) => {
                if (!status) {
                    this.logger.error(
                        'Project authorization failed. Catalogs will not load and the page will ' +
                            'render base language — which looks identical to a working page in ' +
                            'view-source. Check `projectId` and `apiKey`.',
                    );
                    return;
                }
                this.keyType = keyType;
                if (keyType === 'unknown') {
                    this.logger.warn(
                        'Project authorization succeeded but returned no recognisable key type. ' +
                            'Harvesting will be refused, so newly discovered phrases will NOT ' +
                            'self-register.',
                    );
                }
            })
            .catch((err) => {
                this.logger.error('Project authorization threw', err);
            })
            .finally(() => {
                // Stamped on completion, success or not, so a failing authorize backs off
                // instead of re-running in every request's critical path.
                this.lastAuthorizeAt = Date.now();
                this.authorizing = undefined;
            });
        return this.authorizing;
    }

    /**
     * Run `fn` with a request-scoped translation context installed.
     *
     * Everything inside — including `load` functions and plain utility modules with no
     * component context — resolves `t()` against THIS request's locale and catalog.
     *
     * The miss queue is drained after `fn` settles, scheduled onto a later tick so it is
     * never in the TTFB path. Do not await the drain.
     */
    async run<T>(options: RequestScopeOptions, fn: () => T | Promise<T>): Promise<RenderResult<T>> {
        const locale = canonicalizeLocale(options.locale);

        await this.ensureAuthorized();

        const catalog = options.catalog
            ? normalizeCatalog(options.catalog)
            : locale === this.baseLocale
              ? // The base locale has no catalog to fetch: phrases are already written in
                // it. Fetching would be a round-trip for an empty result. Still normalized,
                // so `RenderResult.catalog` has the same shape on every path — a client SDK
                // seeding from a base-locale render must not receive a differently-shaped
                // object than one seeding from `/it`.
                normalizeCatalog({})
              : await this.catalogs.get(locale);

        const scope: RequestScope = {
            locale,
            catalog,
            missQueue: [],
            missSeen: new Set(),
            projectId: this.projectId,
            baseLocale: this.baseLocale,
            logger: this.logger,
            drained: false,
            draining: false,
            posted: 0,
        };

        // Phrases discovered after the scheduled drain — a streamed body still rendering
        // after `run()` resolved — schedule their own drain rather than being dropped.
        scope.onLateMiss = () => {
            scheduleDrain(() => drainMissQueue(scope, this.api, this.keyType, this.harvestEnabled));
        };

        // A render that throws must still harvest. Without the `finally`, a page that
        // errors in a late component discards every phrase discovered up to that point —
        // and an erroring page is exactly where new, unregistered copy tends to live.
        // The error still propagates; only the drain is unconditional.
        let value: T;
        try {
            value = await runInScope(scope, async () => fn());
        } finally {
            scheduleDrain(() => drainMissQueue(scope, this.api, this.keyType, this.harvestEnabled));
        }

        return { value, catalog, locale, missing: scope.missQueue, [SCOPE]: scope };
    }

    /**
     * Drain a scope's misses immediately, returning the promise.
     *
     * For edge runtimes: pass this to `ctx.waitUntil()`. `setImmediate` semantics do not
     * exist there, and a Worker may be torn down the moment the response is returned.
     */
    flush(result: RenderResult<unknown>): Promise<void> {
        // Reuse the scope that rendered, so this shares the once-only latch with the
        // drain `run()` already scheduled. Reconstructing a scope from the public fields
        // gave it a FRESH latch, and the documented Workers path posted the identical
        // queue twice — once here, once microseconds later from the scheduled drain.
        const scope = result[SCOPE];

        if (!scope) {
            this.logger.error(
                'flush() was given a value that did not come from run(). Nothing was drained. ' +
                    'Pass the RenderResult run() returned, not a copy of it.',
            );
            return Promise.resolve();
        }

        return drainMissQueue(scope, this.api, this.keyType, this.harvestEnabled);
    }

    /**
     * Resolve a locale's catalog without rendering anything.
     *
     * For hosts that must publish the catalog to the client BEFORE the render reads it.
     * In SvelteKit, `+layout.server.ts` runs during `resolve(event)`, so assigning
     * `event.locals.langsysCatalog` after `run()` returns is too late — the payload
     * serialises `undefined` and the hand-off silently does not happen.
     *
     * Pass the result straight back into `run({ locale, catalog })`; it is the same
     * object, so this costs one fetch, not two.
     */
    async preloadCatalog(locale: string): Promise<Catalog> {
        const canonical = canonicalizeLocale(locale);
        if (canonical === this.baseLocale) return normalizeCatalog({});
        return this.catalogs.get(canonical);
    }

    /** Drop a locale's cached catalog across every worker sharing the configured cache. */
    invalidate(locale: string): Promise<void> {
        return this.catalogs.invalidate(locale);
    }
}

export function createLangsysServer(config: LangsysServerConfig): LangsysServer {
    return new LangsysServer(config);
}
