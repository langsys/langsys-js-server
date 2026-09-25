/**
 * Logging.
 *
 * SPEC.md §6.3 requires fire-and-forget failures to be logged, and §10 records the
 * failure class this package exists downstream of: **a check that produces no signal
 * reads as a pass.** The base SDK gates its read-only-key refusal behind `if (debug)`,
 * which makes it invisible in the default configuration. That gate is deliberately NOT
 * copied — see `harvest.ts`.
 *
 * `debugEnabled` is per-instance rather than module-global: the base SDK's logger
 * singleton carries process-wide `debugEnabled` (`src/logger.ts:47`), which is state,
 * and this package holds no module-level mutable state at all.
 */

export interface Logger {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    /**
     * Warn at most once per LOGGER, for conditions that are per-instance but whose
     * message is not — a read-only key refusing to harvest is correct production
     * configuration, and repeating it per phrase would bury the log it is meant to
     * surface.
     *
     * Per-logger rather than per-process, which is the fix for a real defect: with a
     * module-global latch, two `createLangsysServer()` instances (two tenants, both
     * read-only-keyed) emitted the warning **once in total**, so the second tenant was
     * silently diagnosed by the first tenant's log. A latch that suppresses a second
     * instance's signal is this project's own failure class wearing a helpful face.
     */
    warnOnce(key: string, message: string): void;
    /** Log once per key, and only when debug logging is on — for notices that are normal, not defects. */
    debugOnce(key: string, message: string): void;
}

const PREFIX = '[langsys-js-server]';

export function createLogger(debugEnabled: boolean): Logger {
    const emitted = new Set<string>();
    const warn = (...args: unknown[]): void => console.warn(PREFIX, ...args);

    return {
        log: (...args) => {
            if (debugEnabled) console.log(PREFIX, ...args);
        },
        // Warnings and errors are UNCONDITIONAL. A warning nobody sees by default is
        // the same as no warning.
        warn,
        error: (...args) => console.error(PREFIX, ...args),
        warnOnce: (key, message) => {
            if (emitted.has(key)) return;
            emitted.add(key);
            warn(message);
        },
        debugOnce: (key, message) => {
            if (!debugEnabled || emitted.has(`debug:${key}`)) return;
            emitted.add(`debug:${key}`);
            console.log(PREFIX, message);
        },
    };
}

/**
 * Emit a message at most once per process, for conditions with no instance to attribute
 * them to.
 *
 * This now serves exactly one caller: `t()` called outside any request scope. There is no
 * `LangsysServer` involved in that case by definition, so per-instance keying is not
 * available and process-level is the honest scope.
 *
 * Everything that DOES have an instance uses `logger.warnOnce()` instead — see the note
 * there on why a process-wide latch across instances was a defect.
 *
 * NOTE this is the only module-scoped mutable state in the package. It is a `Set` of
 * string literals holding warning KEYS, read on the line below to decide whether a given
 * warning has already been printed — so it is read, but only ever to suppress a duplicate
 * log. It never reaches translation output, never varies per request, and never carries
 * tenant data, which is what makes it safe to share across concurrent requests.
 */
const emittedOnce = new Set<string>();

export function warnOnceGlobal(logger: Logger, key: string, message: string): void {
    if (emittedOnce.has(key)) return;
    emittedOnce.add(key);
    logger.warn(message);
}

/** Test-only: reset the once-per-process latch. */
export function __resetWarnOnce(): void {
    emittedOnce.clear();
}
