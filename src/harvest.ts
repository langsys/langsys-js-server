/**
 * Fire-and-forget phrase harvesting.
 *
 * Runtime phrase discovery is the core product mechanic — the phrase IS the key, and
 * phrases are discovered from the running app. A server SDK that does not harvest means
 * the strings most worth translating (indexed body copy, titles, meta) are the ones that
 * never self-register. That is backwards, so harvesting is in scope.
 *
 * Five properties, all required:
 *  1. Request-scoped queue. A module-global flush queue would reintroduce exactly the
 *     cross-request coupling this package exists to avoid.
 *  2. Never in the TTFB path. A translation backend being slow must never make the site
 *     slow.
 *  3. Fire-and-forget, but NOT silent. Failures do not propagate to the request, and
 *     they do not vanish either.
 *  4. Deduplicate before sending. A page rendering the same missing phrase 50 times
 *     posts it once.
 *  5. Write key only. A write key in production registers phrases from live user
 *     traffic, and the catalog pollution is permanent and shared.
 */

import type { LangsysApi, TranslatableItem } from './api.js';
import type { RequestScope } from './context.js';
import type { Logger } from './logger.js';
import type { KeyType, MissingPhrase } from './types.js';

/**
 * Registration batch size when the server advertises no usable cap (REG-9).
 *
 * Matches the JS core's `batchLimit` signal and `langsys-php`'s default. A default that
 * disagreed across SDKs would mean the same page registers in different shapes depending
 * on which SDK rendered it, and only the one exceeding the server's real cap would fail.
 */
export const DEFAULT_BATCH_LIMIT = 200;

/**
 * REG-8 — the first backoff window after a failed registration send, and its ceiling.
 * The spec's "3s → doubling → ~5min": 3, 6, 12 … 192, then 300 from the eighth failure on.
 */
export const REGISTRATION_BACKOFF_INITIAL_MS = 3_000;
export const REGISTRATION_BACKOFF_CEILING_MS = 300_000;

/**
 * One registration failure clock per `LangsysServer` instance (REG-8).
 *
 * **Per instance, never per module.** One process commonly hosts several servers — a
 * project each, a tenant each — and a module-level clock would let one project's broken
 * key silence every other project's registrations. That is CACHE-1's shape, for backoff.
 *
 * **Not request state either, so it does not live in the scope.** Every concurrent request
 * to an instance sends to the same endpoint, so every one must see the same answer: a
 * per-request clock lets each new request fire its own probe at an endpoint that is already
 * failing, which is the storm this exists to stop. It is the same kind of fact as `keyType`
 * and `batchLimit` — identical for every request — with one deliberate difference: it is
 * read at DRAIN time rather than copied in at `run()`, because the point is to react to a
 * failure that landed after this request started rendering.
 *
 * **Only the backoff half of REG-8.** The other half keeps a failed send queued, which
 * needs a queue that outlives the request and is held for a spec ruling. So a phrase
 * dropped here is not retried; it registers the next time it renders after the window.
 */
export class RegistrationBackoff {
    private failures = 0;
    private until = 0;
    /** Bumped on each counted failure, so a send can tell one landed while it was in flight. */
    private episode = 0;
    private announcedEpisode = -1;

    /** Milliseconds until a send may go out; 0 means now. */
    remainingMs(): number {
        return Math.max(0, this.until - Date.now());
    }

    get consecutiveFailures(): number {
        return this.failures;
    }

    /** Take immediately before a send, and hand back to `failed()` if it fails. */
    beginSend(): number {
        return this.episode;
    }

    /** Record a failed send. Returns the milliseconds until the next send may go out. */
    failed(sendToken: number): number {
        // A send that was already in flight when an earlier failure opened this window is
        // the SAME outage, not a consecutive failure. Counting it would double the window
        // once per concurrent request, so the delay would measure traffic, not failures.
        if (this.failures > 0 && sendToken !== this.episode) return this.remainingMs();
        const delay = Math.min(
            REGISTRATION_BACKOFF_INITIAL_MS * 2 ** this.failures,
            REGISTRATION_BACKOFF_CEILING_MS,
        );
        this.failures++;
        this.episode++;
        this.until = Date.now() + delay;
        return delay;
    }

    /** The first success resets to a fresh 3s ladder. */
    succeeded(): void {
        this.failures = 0;
        this.until = 0;
    }

    /** True for the first skipped drain of a window, false for the rest of it. */
    shouldAnnounce(): boolean {
        if (this.announcedEpisode === this.episode) return false;
        this.announcedEpisode = this.episode;
        return true;
    }
}

/**
 * Queue a miss on the CURRENT request's queue, deduplicated.
 *
 * The base SDK deduplicates with an O(n) linear scan per miss over an array that, under
 * the default `ssrTokenStrategy: 'client'`, is never drained on a server — so it grows
 * for the life of the process and the scan cost grows with it. A `Set` keyed on the same
 * identity is O(1) and the queue dies with the request.
 */
export function queueMiss(scope: RequestScope, phrase: string, category: string): void {
    // NUL as the separator, written as an ESCAPE rather than a raw byte. NUL is the right
    // separator for a composite key — a space would let ("a b", "c") and ("a", "b c")
    // collide — but a literal NUL in a source file makes `grep` classify it as binary and
    // return NOTHING, silently, which is indistinguishable from "no match". This file
    // shipped that way briefly and a search for `canHarvest` in it came back empty.
    const key = `${category}\u0000${phrase}`;
    if (scope.missSeen.has(key)) return;
    scope.missSeen.add(key);
    scope.missQueue.push({ phrase, category });

    // A drain has already completed for this request, so nothing is coming to collect
    // this one. Happens whenever the framework streams: `resolve(event)` settles when the
    // headers are ready, and the body — along with any `t()` in it — keeps rendering
    // afterwards. Without this the phrase resolves correctly and never registers, which
    // is exactly the backwards outcome harvesting exists to prevent.
    if (scope.drained) scope.onLateMiss?.();
}

/**
 * Queue an unknown content block on the CURRENT request, deduplicated on category and id.
 *
 * One `content_block` item carrying the block's tokens as its phrases, in order — the shape
 * the core's `registerContentBlock` sends and the API files under the `custom_id`. Sending the
 * tokens as loose phrases instead registers words the block lookup never reads, so the block
 * would never translate.
 */
export function queueBlock(scope: RequestScope, item: TranslatableItem): void {
    const key = `${item.category ?? ''}\u0000${item.custom_id ?? ''}`;
    if (scope.blockSeen.has(key)) return;
    scope.blockSeen.add(key);
    scope.blockQueue.push(item);
    if (scope.drained) scope.onLateMiss?.();
}

/**
 * Whether harvesting may proceed, and a loud, once-per-process explanation when not.
 *
 * Mirrors `registerContentBlock`'s precedent: refuse LOCALLY and never make the call,
 * and return SUCCESS so the render path is unaffected — a read-only key is a correct
 * production configuration, not an error condition.
 *
 * The one thing deliberately NOT copied is the base SDK's `if (config.debug)` gate on
 * the refusal log. That log is invisible in the default configuration, which is exactly
 * the failure class this project keeps hitting: a check that produces no signal reads as
 * a pass. Logged unconditionally, once per process rather than once per phrase.
 */
export function canHarvest(
    writeEnabled: boolean | undefined,
    keyType: KeyType,
    enabled: boolean,
    logger: Logger,
): boolean {
    if (!enabled) {
        logger.warnOnce('harvest-disabled',
            'Harvesting is disabled by configuration. Phrases rendered on the server will ' +
                'NOT self-register, so new copy will not appear in the Translation Manager.',
        );
        return false;
    }

    // GATE-1 — the server's answer, and it is the ONLY thing that decides. `key_type`
    // describes the key; capability describes the session. The same `ip_write` key is
    // write-capable from an allow-listed address and read-only from anywhere else, so no
    // client-side value can express this.
    if (writeEnabled === true) return true;

    if (writeEnabled === false) {
        // OBS-1 — a refusal on a key whose whole point is writing is otherwise completely
        // silent: no request, no error, nothing in the catalog. The integrator believes
        // they are integrated and has nothing to report. One line is the only signal
        // available on a server, where there is no network tab to inspect.
        if (keyType === 'write' || keyType === 'ip_write') {
            logger.warnOnce('harvest-capability-refused',
                `Harvesting is off because the server answered write_enabled: false for this ` +
                    `session, on a "${keyType}" key. Server-rendered phrases will NOT ` +
                    'self-register. For an ip_write key this usually means this server\'s ' +
                    'outbound address is not on the project allow-list — the key is fine and ' +
                    'the address is what needs changing.',
            );
        } else {
            logger.warnOnce('harvest-capability-read',
                'Harvesting is off because the server answered write_enabled: false for this ' +
                    'session. Server-rendered phrases will NOT self-register. This is the ' +
                    'correct and intended configuration for production.',
            );
        }
        return false;
    }

    // GATE-8 — the field is ABSENT, so this response came from a server predating the
    // capability. Falling back to `key_type` is sanctioned here and ONLY here, and only
    // for the plain `write` arm below. Nothing latches: this is re-derived from whatever
    // the most recent response said, so a server upgraded mid-deployment is picked up
    // without an SDK release.
    if (keyType === 'ip_write') {
        // Constraint 1. The decision for an address-dependent key is address-dependent,
        // and the absence of a positive signal IS the answer. Inferring around it is what
        // converts a closed gate into an open one.
        logger.warnOnce('harvest-ip-write-unknown',
            'Harvesting is off because this server did not report write_enabled and the key ' +
                'is ip_write, whose capability depends on the calling address. That cannot be ' +
                'inferred locally, so it is refused rather than guessed. Upgrade the Langsys ' +
                'API to a version that reports write_enabled.',
        );
        return false;
    }

    if (keyType === 'read') {
        logger.warnOnce(
            'harvest-readonly-key',
            'Harvesting is off because the API key is read-only. Server-rendered phrases ' +
                'will NOT self-register. This is the correct and intended configuration for ' +
                'production — a write key in production registers phrases from live user ' +
                'traffic, and that catalog pollution is permanent and shared. Use a write key ' +
                'in development so new copy is discovered there.',
        );
        return false;
    }

    if (keyType !== 'write') {
        // A DIFFERENT latch key from the read-only case, deliberately. Sharing one meant
        // whichever condition fired first permanently suppressed the other — and this
        // message must never be replaced by one asserting the configuration is "correct
        // and intended for production", because the usual cause is a failed authorization.
        logger.warnOnce(
            'harvest-unknown-key',
            'Harvesting is off because the API key type could not be determined. Server-' +
                'rendered phrases will NOT self-register. Unlike a read-only key this is ' +
                'probably NOT what you want: it usually means project authorization failed, ' +
                'so catalogs are not loading either and the page is rendering base language. ' +
                'Check `projectId` and `apiKey`.',
        );
        return false;
    }

    return true;
}

/**
 * Drain a request's miss queue. Call this only AFTER the response has flushed.
 *
 * Returns a promise for tests and for edge runtimes with `waitUntil`; on Node the caller
 * should NOT await it in the request path.
 */
export async function drainMissQueue(
    scope: RequestScope,
    api: LangsysApi,
    enabled: boolean,
    backoff: RegistrationBackoff,
): Promise<void> {
    // A concurrency guard, not a once-only latch. `run()` schedules a drain and the
    // caller may also `flush()`; both must be safe, and a LATER drain must remain
    // possible for phrases discovered in a streamed tail.
    if (scope.draining) return;

    const batch = scope.missQueue.slice(scope.posted);
    const blocks = scope.blockQueue.slice(scope.blocksPosted);
    if (batch.length === 0 && blocks.length === 0) {
        scope.drained = true;
        return;
    }

    // Read from the scope, not from a parameter threaded down from the server instance:
    // this is the decision that was true when THIS request started rendering.
    if (!canHarvest(scope.writeEnabled, scope.keyType, enabled, scope.logger)) {
        // Mark the batch consumed. Otherwise every late miss re-triggers a drain that
        // refuses again, turning a read-only key into a scheduling loop.
        scope.posted = scope.missQueue.length;
        scope.blocksPosted = scope.blockQueue.length;
        scope.drained = true;
        return;
    }

    // REG-8 — this instance is backing off after a failed send, so nothing goes out. The
    // batch is consumed exactly as a refusal consumes it, and for the same reason: a late
    // miss must not re-trigger a drain that will only decline again.
    const waitMs = backoff.remainingMs();
    if (waitMs > 0) {
        scope.posted = scope.missQueue.length;
        scope.blocksPosted = scope.blockQueue.length;
        scope.drained = true;
        // Once per window. Under traffic every render in the window lands here, and a line
        // per render would bury the failure that opened it.
        if (backoff.shouldAnnounce()) {
            scope.logger.warn(
                `Registration is backing off for ${Math.ceil(waitMs / 1000)}s after ` +
                    `${backoff.consecutiveFailures} consecutive failed send(s). ${batch.length + blocks.length} ` +
                    'phrase(s) from this render were not sent, and phrases from other renders in ' +
                    'this window will not be either, without another warning. They are not ' +
                    'retained: each registers the next time it renders after the window.',
            );
        }
        return;
    }

    scope.draining = true;

    const items: TranslatableItem[] = [
        ...batch.map((miss: MissingPhrase): TranslatableItem => ({
            type: 'phrase',
            phrase: miss.phrase,
            category: miss.category,
        })),
        ...blocks,
    ];

    // Advance BEFORE awaiting, so a late miss arriving mid-flight cannot be posted twice.
    scope.posted += batch.length;
    scope.blocksPosted += blocks.length;

    // REG-9 — chunk to the server's cap, which it ENFORCES: an oversized batch is
    // rejected outright, so exceeding it does not send a big request, it loses every
    // phrase in it. REG-7 — sequential, so only one send is ever in flight.
    let sent = 0;
    // Clamped at the LOOP as well as at the reader, and this is defence in depth rather
    // than belt-and-braces: a stride of 0 does not produce a wrong batch, it never
    // advances `offset`, so the drain spins forever inside a `setImmediate` callback and
    // pins a core with no error and no request in flight to blame. Found by mutating the
    // reader's `>= 1` guard away — the mutation did not fail the suite, it HUNG it, which
    // is how the same regression would present in production.
    const stride = Math.max(1, Math.floor(scope.batchLimit) || 1);
    let sendToken = backoff.beginSend();
    try {
        for (let offset = 0; offset < items.length; offset += stride) {
            const chunk = items.slice(offset, offset + stride);
            sendToken = backoff.beginSend();
            const response = await api.createTranslatableItems(chunk);
            if (!response.status) {
                const pausedMs = backoff.failed(sendToken);
                // Fire-and-forget is about not blocking the response. It is not about
                // discarding the outcome — a harvest that silently fails looks identical
                // to one that succeeded, and the phrases just never appear.
                //
                // Stop rather than continue: the remaining chunks are going to the same
                // endpoint that just refused, and hammering it turns one failed batch
                // into a burst. Report what actually landed, not what was collected.
                scope.logger.error(
                    `Failed to register ${chunk.length} phrase(s)` +
                        (sent > 0 ? ` after ${sent} already registered` : '') +
                        `; ${items.length - sent - chunk.length} more not attempted` +
                        `; registration paused for ${Math.ceil(pausedMs / 1000)}s`,
                    response.errors,
                );
                return;
            }
            sent += chunk.length;
            backoff.succeeded();
        }
        scope.logger.log(`Registered ${sent} phrase(s) for "${scope.locale}"`);
    } catch (err) {
        const pausedMs = backoff.failed(sendToken);
        scope.logger.error(
            `Failed to register ${items.length - sent} phrase(s); registration paused for ` +
                `${Math.ceil(pausedMs / 1000)}s`,
            err,
        );
    } finally {
        scope.draining = false;
        scope.drained = true;
    }
}

/**
 * Schedule a drain for after the current response has flushed.
 *
 * `setImmediate` runs after I/O callbacks for the current tick, which on Node means
 * after the response bytes have been handed to the socket. Where it does not exist
 * (Workers, Deno), fall back to a macrotask.
 *
 * On edge runtimes prefer passing the promise to `ctx.waitUntil()` instead — see README.
 */
export function scheduleDrain(run: () => Promise<void>): void {
    const schedule: (cb: () => void) => void =
        typeof setImmediate === 'function' ? setImmediate : (cb) => setTimeout(cb, 0);

    schedule(() => {
        void run().catch(() => {
            // `run` already logs. This catch exists so an unhandled rejection cannot
            // take the process down from a background task.
        });
    });
}
