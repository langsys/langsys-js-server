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
}

const PREFIX = '[langsys-js-server]';

export function createLogger(debugEnabled: boolean): Logger {
    return {
        log: (...args) => {
            if (debugEnabled) console.log(PREFIX, ...args);
        },
        // Warnings and errors are UNCONDITIONAL. A warning nobody sees by default is
        // the same as no warning.
        warn: (...args) => console.warn(PREFIX, ...args),
        error: (...args) => console.error(PREFIX, ...args),
    };
}

/**
 * Emit a message at most once per process.
 *
 * For conditions that are per-phrase or per-request but whose message is not: a
 * read-only key refusing to harvest is correct production configuration, and logging
 * it once per phrase would bury the log it is meant to surface.
 *
 * NOTE this is the one deliberate piece of module-scoped state in the package, and it
 * is a `Set` of strings that is only ever added to — never read for behaviour, never
 * request-varying, never carrying tenant data. Contrast `langsys-php`'s
 * `static $requirementsWarned`, which under FPM means "once per request" and under a
 * persistent worker silently becomes "once at boot and never again". Here that IS the
 * intent, stated rather than inherited.
 */
const emittedOnce = new Set<string>();

export function warnOnce(logger: Logger, key: string, message: string): void {
    if (emittedOnce.has(key)) return;
    emittedOnce.add(key);
    logger.warn(message);
}

/** Test-only: reset the once-per-process latch. */
export function __resetWarnOnce(): void {
    emittedOnce.clear();
}
