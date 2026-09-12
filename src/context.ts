/**
 * Request-scoped resolution. Everything else in this package depends on it.
 *
 * The precise problem this solves is NOT "the base SDK's singleton is a bug" — it is
 * **there is no request-scoped translator in the SDK.** A non-singleton class with
 * module-global state races identically.
 *
 * Under a long-lived server one process serves every concurrent request, so seeding
 * module globals server-side is a cross-request data race: an in-flight `/de` render
 * can observe `/it`'s catalog. The race needs an `await` between write and read, which
 * every async `load` function provides — so it is load-dependent and **cannot reproduce
 * in development with one user.**
 *
 * `AsyncLocalStorage` rather than framework context because `t()` is legitimately
 * called from `load` functions and plain utility modules that have no component
 * context. Ambient scoping is a requirement, not a convenience.
 *
 * Available on Node >=16, Deno, Bun, and Cloudflare Workers with `nodejs_compat`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Catalog, KeyType, MissingPhrase } from './types.js';
import type { Logger } from './logger.js';

export interface RequestScope {
    locale: string;
    /**
     * The catalog this request renders against. Immutable for the request's lifetime —
     * a mid-render refresh would let one page render two different catalog versions.
     */
    catalog: Catalog;
    /** Request-scoped. A module-global queue would reintroduce the coupling this package exists to avoid. */
    missQueue: MissingPhrase[];
    /** Deduplication index for `missQueue`, so a page rendering the same miss 50 times posts it once. */
    missSeen: Set<string>;
    projectId: string | number;
    baseLocale: string;
    logger: Logger;
    /**
     * This request's write capability, as the server most recently reported it, captured
     * when the scope was built and immutable for the request's lifetime.
     *
     * `undefined` means the server never sent `write_enabled` — a pre-capability server.
     * That is a version signal, never permission; see GATE-8 and `canHarvest`.
     *
     * Held here rather than read off the server instance at drain time so the decision a
     * request acts on is the one that was true when it started. The drain runs after the
     * response has flushed, by which point a concurrent catalog refresh may have changed
     * the instance's copy — and a request must not register under a capability that
     * arrived after it finished rendering.
     */
    writeEnabled: boolean | undefined;
    /** Captured alongside `writeEnabled`, and used ONLY for GATE-8's bounded fallback. */
    keyType: KeyType;
    /**
     * False when this request's catalog could not be fetched (WIRE-4 clause 2).
     *
     * The render still degrades to source text — that part was always right. What this
     * gates is REGISTRATION: with no catalog, every phrase looks like a miss, so queueing
     * them turns an API outage into a write storm against the same API, sized by how much
     * copy the page has. Degrading and recording nothing is the specified behaviour, and
     * the intuitive alternative is the wrong one.
     */
    catalogAvailable: boolean;
    /**
     * The server's registration batch cap for this request (REG-9).
     *
     * Captured per request for the same reason as the capability: the drain runs after
     * the response flushed, and a batch must be chunked to the limit that was current
     * when it was collected.
     */
    batchLimit: number;
    /** True once at least one drain has completed for this request. */
    drained: boolean;
    /** Guard against two drains running concurrently for the same request. */
    draining: boolean;
    /**
     * How many entries of `missQueue` have already been POSTed.
     *
     * An index rather than emptying the queue, so `RenderResult.missing` stays a complete
     * record of what this render could not resolve — a caller reading it after the drain
     * must not find it mysteriously empty.
     */
    posted: number;
    /**
     * Called when a miss is queued AFTER a drain has already completed.
     *
     * A streamed response keeps producing body — and calling `t()` — after `run()`'s
     * promise resolves. AsyncLocalStorage propagates the scope into that tail correctly,
     * so those phrases RESOLVE correctly; without this hook they simply never register.
     */
    onLateMiss?: () => void;
}

/**
 * NOTE: this is module-scoped, and that is correct — it is the ONLY way ambient
 * scoping can work. `AsyncLocalStorage` itself holds no request data; it is a keyed
 * accessor into per-async-context storage. The values it returns are per-request by
 * construction, which is exactly the property the base SDK's module globals lack.
 */
const storage = new AsyncLocalStorage<RequestScope>();

/** The current request's scope, or `undefined` outside one. */
export function getScope(): RequestScope | undefined {
    return storage.getStore();
}

/** Run `fn` with `scope` installed as the ambient request scope. */
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
    return storage.run(scope, fn);
}

/**
 * The message shown when a primitive is called outside a request scope.
 *
 * This does NOT throw. A server SDK that throws on a missing scope turns a translation
 * problem into a 500, and the correct degraded behaviour — render the base language —
 * is exactly what the caller gets anyway. But it must be LOUD: rendering base language
 * silently is the original defect this whole package exists to correct, and it looks
 * identical to a working page in every `curl`-shaped check.
 */
export const NO_SCOPE_MESSAGE =
    't() was called outside a request scope, so it returned the base-language phrase ' +
    'unchanged. Server-rendered HTML from this call site will NOT be translated. Wrap ' +
    'the render in `langsys.run({ locale }, ...)` — see the README. This is silent in ' +
    'the base locale and invisible in view-source, so it is warned about here rather ' +
    'than discovered in production.';
