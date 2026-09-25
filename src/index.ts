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
import { getScope, runInScope, type RequestScope } from './context.js';
import { DEFAULT_BATCH_LIMIT, RegistrationBackoff, RetainedQueue, drainMissQueue, queueMiss, scheduleDrain } from './harvest.js';
import { createLogger } from './logger.js';
import { RESOLVED_MARKER_ATTR, canonicalizeLocale } from 'langsys-js-typescript/pure';
import { resolveRequestLocale, type ResolveLocaleOptions, type ResolvedLocale } from './locale.js';
import { buildMessage, checkTemplate, DEFAULT_SERVER_MESSAGE_CATEGORY, type MessageInput, type ServerMessage } from './messages.js';
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
export {
    generateCustomId,
    generateLegacyCustomId,
    interpolate,
    canonicalizeLocale,
} from 'langsys-js-typescript/pure';
export {
    TRANSLATABLE_ATTRIBUTES,
    PHRASE_MARKER_ATTRS,
    PHRASE_MARKER_ATTRS_EMIT,
    SKIP_ELEMENTS,
    UNCATEGORIZED,
    CONTENT_BLOCK_MARKER_ATTRS,
    CONTENT_BLOCK_MARKER_EMIT,
} from './constants.js';
export { normalizeCatalog } from './catalog.js';
export { encodePhrase, type EncodedPhrase } from './phrase.js';
export {
    renderTranslateBlock,
    stampContentBlock,
    blockId,
    UncapturableChildError,
    type RenderedBlock,
} from './blocks.js';
export { auditRenderedHtml, type AuditFinding, type AuditResult, type AuditOptions } from './audit.js';
export type { Logger } from './logger.js';
export type { ResolveLocaleOptions, ResolvedLocale } from './locale.js';
export {
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    SERVER_MESSAGE_CODES,
    checkTemplate,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    toServerMessage,
    type MessageInput,
    type ServerMessage,
} from './messages.js';
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
 * Marks a catalog that came back from a FAILED fetch, so `run()` can tell it apart from
 * one a host built or fetched successfully.
 *
 * `preloadCatalog()` returns a plain `Catalog` and must keep doing so — it is public API,
 * and the object is handed straight to a framework's serialiser (`event.locals` in
 * SvelteKit) on the documented path. So the signal rides along as a non-enumerable Symbol
 * property: invisible to `JSON.stringify`, to `Object.keys`, to devalue, and to anything
 * else that walks the catalog, while surviving the one hop that matters — host variable to
 * `run({ catalog })` in the same process.
 *
 * Absence means available, which is the fail-safe default: a hand-built catalog carries no
 * marker and registers normally. Only a fetch this package performed and watched fail can
 * set it.
 */
const CATALOG_FAILED = Symbol('langsys.catalogFailed');

/** Tag a catalog object as the product of a failed fetch, without changing its shape. */
function markUnavailable(catalog: Catalog): Catalog {
    Object.defineProperty(catalog, CATALOG_FAILED, {
        value: true,
        enumerable: false,
        writable: false,
        configurable: true,
    });
    return catalog;
}

/**
 * How long to wait before retrying a failed project authorization.
 *
 * Authorize sits in front of TTFB. Retrying on every request turns a backend problem
 * into a site-wide latency problem — the inverse of the rule that a slow translation
 * backend must never make the site slow.
 */
const AUTHORIZE_RETRY_MS = 60_000;

/** REG-3: the longest a best-effort exit drain may hold a terminating process. */
const SHUTDOWN_DRAIN_MS = 2_000;

/** MSG-8: how many emitted templates one server object remembers having queued. */
const MAX_QUEUED_TEMPLATES = 10_000;

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
     * Key type is discovered from the authorize response, not configured.
     *
     * It never decides whether to write — that is `write_enabled`, and GATE-1 is explicit
     * that `key_type` describes the KEY while capability describes the SESSION. This is
     * kept only for GATE-8's bounded fallback, and caching it is sanctioned: it is a
     * property of the API key, so every request on this instance sees the same value and
     * there is nothing to race on.
     *
     * Three fields on this class are written after construction — this, `writeEnabled`
     * and `batchLimit` — and all three are server facts rather than request facts. Each
     * is COPIED into the request scope in `run()`, and nothing reads them at drain time.
     * Stated explicitly because "an instance field that is written once" is precisely the
     * shape that turns out to be per-request state in disguise, and `writeEnabled` is a
     * value that genuinely would be per-request on an SDK that supported write grants.
     */
    private keyType: KeyType = 'unknown';
    /**
     * The session's write capability as the server most recently reported it.
     * `undefined` = never reported, i.e. a pre-capability server (GATE-8).
     *
     * Refreshed from BOTH endpoints that carry it — `authorize()` seeds it, and every
     * catalog fetch's envelope updates it — so nothing here is latched at init. Each
     * request copies the current value into its own scope; this field is never read at
     * drain time.
     */
    private writeEnabled: boolean | undefined;
    /**
     * The server's registration batch cap (REG-9), seeded from authorize and defaulted
     * until it answers. Never hardcoded at the send site — the server enforces this and
     * rejects an oversized batch wholesale.
     */
    private batchLimit: number = DEFAULT_BATCH_LIMIT;
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
    /**
     * REG-8's failure clock — one per instance, never per module, and never in the scope.
     * The one server fact here that is read at drain time rather than copied in at `run()`;
     * `RegistrationBackoff` explains why each of those alternatives is wrong.
     */
    private readonly registrationBackoff = new RegistrationBackoff();
    /** REG-8's retained items and GATE-2's held ones, each on the request that collected it. */
    private readonly retained: RetainedQueue;
    private readonly flushOnExit: boolean;
    private exitHooks: { beforeExit: () => void; signal: (signal: NodeJS.Signals) => void } | undefined;
    private exitAttempted = false;
    /**
     * The locales the project serves, as authorization last reported them (SRV-6). A property
     * of the project, identical for every request, like the key type.
     */
    private servedLocales: string[] | undefined;
    /** The category server message templates live under (MSG-6). */
    readonly messageCategory: string;
    /**
     * Templates this server object has already queued for registration (MSG-8), so an API
     * answering at its base locale — where no catalog is fetched to compare against — does not
     * re-register the same sentence on every request. The same for every request; bounded.
     */
    private readonly queuedTemplates = new Set<string>();

    constructor(config: LangsysServerConfig) {
        if (!config.projectId) throw new Error('createLangsysServer: `projectId` is required');
        if (!config.apiKey) throw new Error('createLangsysServer: `apiKey` is required');
        if (!config.baseLocale) throw new Error('createLangsysServer: `baseLocale` is required');

        this.projectId = config.projectId;
        this.baseLocale = canonicalizeLocale(config.baseLocale);
        this.harvestEnabled = config.harvest ?? true;
        this.flushOnExit = config.flushOnExit ?? true;
        this.messageCategory = config.messageCategory ?? DEFAULT_SERVER_MESSAGE_CATEGORY;
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
            // GATE-8 constraint 2: re-evaluated per response. The catalog endpoint
            // reports the flag on its envelope, and that fetch happens anyway.
            (writeEnabled) => {
                this.writeEnabled = writeEnabled;
            },
        );
        this.retained = new RetainedQueue(
            async (scope, force) => {
                // A request held on an unknown decision (GATE-2) re-reads it: authorization may
                // have answered since. Any other request keeps the decision it rendered under.
                if (scope.keyType === 'unknown' && scope.writeEnabled === undefined) {
                    await this.ensureAuthorized();
                    scope.keyType = this.keyType;
                    scope.writeEnabled = this.writeEnabled;
                }
                await drainMissQueue(scope, this.api, this.harvestEnabled, this.registrationBackoff, this.retained, force);
            },
            this.logger,
            (size) => this.syncExitHooks(size),
        );
    }

    /**
     * REG-3: while anything is held, a best-effort drain runs when the process is about to exit.
     * Registered only while the retained queue is non-empty, so an idle server object adds no
     * process listeners. Once per process: an exit that still cannot send does not retry.
     *
     * On SIGTERM/SIGINT the handler removes itself before draining and, when no other listener
     * remains, re-raises the signal afterwards, so the process still terminates as it would have
     * without this package. The drain is bounded and never throws.
     */
    private syncExitHooks(size: number): void {
        const proc = (globalThis as { process?: NodeJS.Process }).process;
        if (!this.flushOnExit || typeof proc?.on !== 'function') return;
        if (size > 0 && !this.exitHooks && !this.exitAttempted) {
            const beforeExit = (): void => {
                if (this.exitAttempted) return;
                this.exitAttempted = true;
                void this.retained.shutdown(SHUTDOWN_DRAIN_MS);
            };
            const signal = (sig: NodeJS.Signals): void => {
                proc.off(sig, signal);
                this.exitAttempted = true;
                void this.retained.shutdown(SHUTDOWN_DRAIN_MS).finally(() => {
                    if (proc.listenerCount(sig) === 0) proc.kill(proc.pid, sig);
                });
            };
            proc.on('beforeExit', beforeExit);
            proc.on('SIGTERM', signal);
            proc.on('SIGINT', signal);
            this.exitHooks = { beforeExit, signal };
        } else if ((size === 0 || this.exitAttempted) && this.exitHooks) {
            proc.off('beforeExit', this.exitHooks.beforeExit);
            proc.off('SIGTERM', this.exitHooks.signal);
            proc.off('SIGINT', this.exitHooks.signal);
            this.exitHooks = undefined;
        }
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
            .then(({ status, keyType, writeEnabled, batchLimit, locales }) => {
                if (!status) {
                    this.logger.error(
                        'Project authorization failed. Catalogs will not load and the page will ' +
                            'render base language — which looks identical to a working page in ' +
                            'view-source. Check `projectId` and `apiKey`.',
                    );
                    return;
                }
                this.keyType = keyType;
                this.writeEnabled = writeEnabled;
                if (batchLimit !== undefined) this.batchLimit = batchLimit;
                if (locales?.length) this.servedLocales = locales;
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

        // `catalogAvailable` is tracked alongside the catalog itself, because an empty
        // catalog means two opposite things and they are indistinguishable by shape: a
        // project with nothing to translate, or a fetch that failed. WIRE-4 clause 2 turns
        // on telling them apart — without a catalog a miss cannot be distinguished from a
        // hit, so registering on the failed path re-registers the whole page.
        //
        // A caller-supplied catalog and the base locale both count as AVAILABLE. The first
        // is an answer the host already had; the second needs no fetch, and never queues
        // anyway because a base-locale miss is not a miss.
        let catalog: Catalog;
        let catalogAvailable = true;
        if (options.catalog) {
            // A caller-supplied catalog is available UNLESS it is carrying the failed-fetch
            // marker `preloadCatalog()` puts on it, or the caller says otherwise outright.
            // The first version of this trusted the caller unconditionally, on the reasoning
            // that handing us a catalog is taking responsibility for it — which is wrong in
            // exactly the case that matters, because a host cannot take responsibility for a
            // failure this package never told it about. That left the documented
            // preloadCatalog → run path storming while the inline path was fixed.
            catalogAvailable = !(CATALOG_FAILED in options.catalog);
            catalog = normalizeCatalog(options.catalog);
        } else if (locale === this.baseLocale) {
            // The base locale has no catalog to fetch: phrases are already written in it.
            // Fetching would be a round-trip for an empty result. Still normalized, so
            // `RenderResult.catalog` has the same shape on every path — a client SDK
            // seeding from a base-locale render must not receive a differently-shaped
            // object than one seeding from `/it`.
            catalog = normalizeCatalog({});
        } else {
            const resolved = await this.catalogs.get(locale);
            catalog = resolved.catalog;
            catalogAvailable = resolved.ok;
        }

        // An explicit option always wins. A host that fetches its own catalog and knows the
        // fetch failed has no other way to say so.
        if (options.catalogAvailable !== undefined) catalogAvailable = options.catalogAvailable;

        const scope: RequestScope = {
            locale,
            catalog,
            missQueue: [],
            missSeen: new Set(),
            blockQueue: [],
            blockSeen: new Set(),
            blocksPosted: 0,
            retryItems: [],
            projectId: this.projectId,
            baseLocale: this.baseLocale,
            logger: this.logger,
            // Captured AFTER the catalog resolved, so a first render at a new locale acts
            // on the capability that same response just reported rather than on the
            // staler one authorize() left behind.
            writeEnabled: this.writeEnabled,
            keyType: this.keyType,
            catalogAvailable,
            batchLimit: this.batchLimit,
            drained: false,
            draining: false,
            posted: 0,
        };

        // Phrases discovered after the scheduled drain — a streamed body still rendering
        // after `run()` resolved — schedule their own drain rather than being dropped.
        scope.onLateMiss = () => {
            scheduleDrain(() => drainMissQueue(scope, this.api, this.harvestEnabled, this.registrationBackoff, this.retained));
        };

        // A render that throws must still harvest. Without the `finally`, a page that
        // errors in a late component discards every phrase discovered up to that point —
        // and an erroring page is exactly where new, unregistered copy tends to live.
        // The error still propagates; only the drain is unconditional.
        let value: T;
        try {
            value = await runInScope(scope, async () => fn());
        } finally {
            scheduleDrain(() => drainMissQueue(scope, this.api, this.harvestEnabled, this.registrationBackoff, this.retained));
        }

        return { value, catalog, locale, missing: scope.missQueue, [SCOPE]: scope };
    }

    /**
     * Drain a scope's misses immediately, returning the promise.
     *
     * For edge runtimes: pass this to `ctx.waitUntil()`. `setImmediate` semantics do not
     * exist there, and a Worker may be torn down the moment the response is returned.
     */
/**
     * Choose a request's locale (SRV-6): the URL, then a cookie, then `Accept-Language`, each
     * validated against the locales the project serves. Returns the locale and the headers the
     * response must name in `Vary`. Until authorization has reported the project's locales, only
     * the base locale is served.
     */
    async resolveLocale(request: Request, options: ResolveLocaleOptions = {}): Promise<ResolvedLocale> {
        await this.ensureAuthorized();
        return resolveRequestLocale(request, this.servedLocales ?? [this.baseLocale], this.baseLocale, options);
    }

    /**
     * The attribute a server render stamps on its root element (GATE-10, producing half):
     * `data-ls-resolved` with the render locale when it is not the base locale, and nothing for
     * a base-locale render, which is source and must stay discoverable.
     */
    resolvedRootAttributes(locale: string): Record<string, string> {
        const canonical = canonicalizeLocale(locale);
        return canonical === this.baseLocale ? {} : { [RESOLVED_MARKER_ATTR]: canonical };
    }

/**
     * Build a server message entry (MSG-1, MSG-4) and, inside `run()`, register its template.
     *
     * A template the request's catalog does not list under `messageCategory` is queued after the
     * response on the ordinary drain, under the same write gate, so the first user sees the source
     * and later ones the translation (MSG-8). A marker filled with a string that is itself a phrase
     * in the catalog warns once per template and marker: a translatable value in a marker can
     * never be translated (MSG-11).
     */
    message(input: MessageInput): ServerMessage {
        const entry = buildMessage(input);
        const scope = getScope();
        if (!scope) return entry;

        const bucket = scope.catalog[this.messageCategory] as Record<string, unknown> | undefined;
        const listed = bucket !== undefined && Object.prototype.hasOwnProperty.call(bucket, input.template);
        if (!listed && scope.catalogAvailable && !this.queuedTemplates.has(input.template)) {
            if (this.queuedTemplates.size < MAX_QUEUED_TEMPLATES) this.queuedTemplates.add(input.template);
            queueMiss(scope, input.template, this.messageCategory);
        }

        for (const [name, value] of Object.entries(input.params ?? {})) {
            if (typeof value !== 'string' || !value) continue;
            const catalogued = Object.values(scope.catalog).some(
                (b) => typeof b === 'object' && b !== null && Object.prototype.hasOwnProperty.call(b, value),
            );
            if (catalogued) {
                scope.logger.warnOnce(
                    `msg-marker:${input.template}:${name}`,
                    `The marker {${name}} in "${input.template}" was filled with "${value}", a catalogued ` +
                        'phrase. A value in a marker is never translated, so the sentence will not agree ' +
                        'with it; write the value into its own template instead.',
                );
            }
        }
        return entry;
    }

    /**
     * The default error envelope (MSG-1): `{ status: false, error: { ...top, errors } }`, where the
     * top entry defaults to `validation_failed`. An app with its own error body keeps it; clients
     * resolve entries wherever they sit.
     */
    errorBody(errors: ServerMessage[], top?: MessageInput): { status: false; error: ServerMessage & { errors: ServerMessage[] } } {
        const head = this.message(top ?? { code: 'validation_failed', template: 'The request failed validation.' });
        return { status: false, error: { ...head, errors } };
    }

    /**
     * List, check and optionally register every declared template (MSG-7).
     *
     * Each template is checked (MSG-3, MSG-11); a refused one is reported with where it came from
     * and why, and is not registered. With `register`, templates the project's catalog does not
     * already list under `messageCategory` are registered, so a second run registers nothing new.
     */
    async registerTemplates(
        declared: readonly (string | { template: string; where?: string })[],
        options: { register?: boolean } = {},
    ): Promise<{ templates: string[]; problems: { template: string; where?: string; problem: string }[]; registered: string[] }> {
        const templates: string[] = [];
        const problems: { template: string; where?: string; problem: string }[] = [];
        for (const item of declared) {
            const template = typeof item === 'string' ? item : item.template;
            const where = typeof item === 'string' ? undefined : item.where;
            const problem = checkTemplate(template);
            if (problem) problems.push({ template, ...(where ? { where } : {}), problem });
            else if (!templates.includes(template)) templates.push(template);
        }
        if (!options.register || !templates.length) return { templates, problems, registered: [] };

        await this.ensureAuthorized();
        if (this.writeEnabled === false || (this.writeEnabled === undefined && this.keyType !== 'write')) {
            problems.push({ template: '', problem: 'this API key may not register phrases; use a write key' });
            return { templates, problems, registered: [] };
        }
        const probe = (this.servedLocales ?? []).find((l) => l !== this.baseLocale);
        const listed = probe ? (await this.catalogs.get(probe)).catalog[this.messageCategory] : undefined;
        const fresh = templates.filter((t) => !(listed && Object.prototype.hasOwnProperty.call(listed, t)));
        const stride = Math.max(1, Math.floor(this.batchLimit) || 1);
        const registered: string[] = [];
        for (let i = 0; i < fresh.length; i += stride) {
            const chunk = fresh.slice(i, i + stride);
            const res = await this.api.createTranslatableItems(chunk.map((phrase) => ({ type: 'phrase', phrase, category: this.messageCategory })));
            if (!res.status) {
                problems.push({ template: '', problem: `registration failed after ${registered.length}: ${JSON.stringify(res.errors)}` });
                break;
            }
            registered.push(...chunk);
        }
        if (registered.length && probe) await this.catalogs.invalidate(probe);
        return { templates, problems, registered };
    }

/**
     * A catalog snapshot for `locale` (SNAP-1): `GET /translations/data` filtered by category on
     * this side, with no export endpoint. The shape is the catalog's, category to phrase to
     * translation, so it loads as a preloaded catalog unchanged. A snapshot is a cache produced
     * here and refreshed by exporting again, never edited by hand (SNAP-3). A failed fetch throws
     * rather than returning an empty snapshot that would pass for one.
     */
    async exportSnapshot(locale: string, categories?: readonly string[]): Promise<Catalog> {
        const res = await this.api.getTranslationData(locale);
        const data = res.data;
        if (!res.status || data === undefined || data === null || typeof data !== 'object') {
            throw new Error(`Could not export a snapshot for "${locale}": ${JSON.stringify(res.errors ?? res.status)}`);
        }
        // An empty project answers `data: []`.
        const catalog = (Array.isArray(data) ? {} : data) as Catalog;
        if (!categories) return catalog;
        const out: Catalog = {};
        for (const category of categories) {
            if (Object.prototype.hasOwnProperty.call(catalog, category)) out[category] = catalog[category]!;
        }
        return out;
    }

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

        return drainMissQueue(scope, this.api, this.harvestEnabled, this.registrationBackoff, this.retained);
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

        // Still a plain `Catalog`, because this is public API and the object goes straight
        // into a framework's serialised payload. When the fetch FAILED the result carries a
        // non-enumerable marker so `run({ catalog })` can decline to register against it —
        // see CATALOG_FAILED. Without that, the documented preload path re-registers every
        // phrase on the page during an API outage, which is the defect WIRE-4 clause 2
        // names and which this package shipped on that path after fixing it on the other.
        const resolved = await this.catalogs.get(canonical);
        return resolved.ok ? resolved.catalog : markUnavailable(resolved.catalog);
    }

    /** Drop a locale's cached catalog across every worker sharing the configured cache. */
    invalidate(locale: string): Promise<void> {
        return this.catalogs.invalidate(locale);
    }
}

export function createLangsysServer(config: LangsysServerConfig): LangsysServer {
    return new LangsysServer(config);
}
