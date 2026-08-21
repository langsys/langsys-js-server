/** A category bucket in a fetched catalog. */
export interface CatalogCategory {
    /** Required by the client SDK's `iTranslations` shape. No runtime code branches on it. */
    __category__?: string;
    __symbol__?: string;
    /**
     * A plain phrase resolves to a string. A CONTENT BLOCK resolves to an object.
     * `value || phrase` does not guard the object case — the check must be
     * `typeof value === 'string' && value.length > 0`.
     */
    [key: string]: string | Record<string, unknown> | undefined;
}

export type Catalog = Record<string, CatalogCategory>;

/** Discovered from the authorize response, never configured. */
export type KeyType = 'read' | 'write' | 'unknown';

export interface LangsysServerConfig {
    projectId: string | number;
    apiKey: string;
    /** The language your source phrases are written in. Never fetched or harvested. */
    baseLocale: string;
    apiUrl?: string;
    debug?: boolean;
    /** How long a fetched catalog stays fresh. Default 300s. */
    catalogTtlSeconds?: number;
    /**
     * Cross-request/cross-worker catalog cache.
     *
     * Without one, every worker holds an independent in-process catalog and the same
     * URL alternates between old and new copy during propagation depending on which
     * worker answers — which reads to a non-engineer as "my change didn't save".
     * See README "Caching and freshness".
     */
    cache?: SharedCache;
    /** Disable harvesting outright, regardless of key type. */
    harvest?: boolean;
    fetch?: typeof globalThis.fetch;
}

/**
 * A cross-request cache tier.
 *
 * Expiry is stamped ABSOLUTELY at write time into the shared record, so every reader
 * sees the same expiry instant and workers expire together rather than drifting by
 * however long each has been up. A per-process "cached at" clock is what makes
 * propagation staggered; an absolute stamp inside the shared record makes it atomic.
 */
export interface SharedCache {
    get(key: string): Promise<string | null> | string | null;
    set(key: string, value: string, ttlSeconds: number): Promise<void> | void;
    delete(key: string): Promise<void> | void;
}

export interface RequestScopeOptions {
    /** The locale to render. Deterministic resolution is a hard requirement — prefer the URL. */
    locale: string;
    /** Pre-fetched catalog, if the host already has one. Skips the fetch entirely. */
    catalog?: Catalog;
}

/** A phrase discovered during render that the catalog did not resolve. */
export interface MissingPhrase {
    phrase: string;
    category: string;
}

export interface TranslateParams {
    [key: string]: string | number | boolean | Date | null | undefined;
}
