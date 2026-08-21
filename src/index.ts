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
export { tokenizeHtml, isPhraseMarked, isTranslationExcluded } from './tokenizer.js';
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
export { auditRenderedHtml, type AuditFinding, type AuditResult } from './audit.js';
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

export interface RenderResult<T> {
    value: T;
    /** The catalog this render used. Hand it to a client SDK to seed hydration. */
    catalog: Catalog;
    locale: string;
    /** Phrases this render could not resolve. Already queued for harvesting. */
    missing: MissingPhrase[];
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

    /** Authorize once per process, coalescing concurrent callers. */
    private async ensureAuthorized(): Promise<void> {
        if (this.keyType !== 'unknown') return;
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
            })
            .catch((err) => {
                this.logger.error('Project authorization threw', err);
            })
            .finally(() => {
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
                // it. Fetching would be a round-trip for an empty result.
                {}
              : await this.catalogs.get(locale);

        const scope: RequestScope = {
            locale,
            catalog,
            missQueue: [],
            missSeen: new Set(),
            projectId: this.projectId,
            keyType: this.keyType,
            baseLocale: this.baseLocale,
            logger: this.logger,
            drained: false,
        };

        const value = await runInScope(scope, async () => fn());

        scheduleDrain(() => drainMissQueue(scope, this.api, this.keyType, this.harvestEnabled));

        return { value, catalog, locale, missing: scope.missQueue };
    }

    /**
     * Drain a scope's misses immediately, returning the promise.
     *
     * For edge runtimes: pass this to `ctx.waitUntil()`. `setImmediate` semantics do not
     * exist there, and a Worker may be torn down the moment the response is returned.
     */
    flush(result: RenderResult<unknown>): Promise<void> {
        const scope: RequestScope = {
            locale: result.locale,
            catalog: result.catalog,
            missQueue: result.missing,
            missSeen: new Set(result.missing.map((m) => `${m.category} ${m.phrase}`)),
            projectId: this.projectId,
            keyType: this.keyType,
            baseLocale: this.baseLocale,
            logger: this.logger,
            drained: false,
        };
        return drainMissQueue(scope, this.api, this.keyType, this.harvestEnabled);
    }

    /** Drop a locale's cached catalog across every worker sharing the configured cache. */
    invalidate(locale: string): Promise<void> {
        return this.catalogs.invalidate(locale);
    }
}

export function createLangsysServer(config: LangsysServerConfig): LangsysServer {
    return new LangsysServer(config);
}
