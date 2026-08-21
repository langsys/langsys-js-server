/**
 * `t()` — the one translator.
 *
 * SPEC.md §2 lists "a second user-facing translator API" as explicitly out of scope: if
 * integrators must choose per call site between two translators, this package has
 * failed. The interim hand-rolled helper that `langsys-skill` currently prescribes
 * forces exactly that choice, and BOTH wrong answers fail silently — the reactive one
 * renders base language into server HTML (invisible except in view-source), and the pure
 * one renders correctly and then goes stale.
 *
 * So `t()` here is signature-compatible with the client SDKs' `t()`. Migrating off the
 * interim helper is: delete the local `ct`/`makeCatalogT`, import this instead.
 */

import { getScope, NO_SCOPE_MESSAGE } from './context.js';
import { queueMiss } from './harvest.js';
import { UNCATEGORIZED } from './constants.js';
import { findUnusedParamKeys, interpolate } from './vendor/pure.js';
import { warnOnceGlobal, type Logger } from './logger.js';
import type { TranslateParams } from './types.js';

export interface TFunction {
    (phrase: string): string;
    (phrase: string, category: string): string;
    (phrase: string, params: TranslateParams): string;
    (phrase: string, category: string, params: TranslateParams): string;
}

/**
 * Translate a phrase using the current request's catalog.
 *
 * Resolution mirrors the base SDK's `buildTFn` minus the reactive plumbing. Two traps
 * are encoded here deliberately, both of which have bitten this family before:
 *
 *  - **A content block resolves to an OBJECT, not a string.** `value || phrase` does not
 *    fall back correctly for it — the check must be
 *    `typeof value === 'string' && value.length > 0`.
 *  - **Interpolation is not optional.** Omitting it renders the literal `Hello {name}`
 *    server-side and correctly client-side: a hydration mismatch on precisely the
 *    strings carrying data.
 */
/**
 * There is no request logger outside a scope, by definition. Allocated once at module
 * scope rather than per call — this sits on a path that fires for every out-of-scope
 * `t()`, and the latch has usually already fired by then.
 */
const CONSOLE_LOGGER: Logger = {
    log() {},
    warn: (...args: unknown[]) => console.warn('[langsys-js-server]', ...args),
    error: (...args: unknown[]) => console.error('[langsys-js-server]', ...args),
    warnOnce: (_key: string, message: string) => console.warn('[langsys-js-server]', message),
};

export const t: TFunction = (
    phrase: string,
    second?: string | TranslateParams,
    third?: TranslateParams,
): string => {
    const category = typeof second === 'string' ? second : '';
    const params = (typeof second === 'object' && second !== null ? second : third) as
        | TranslateParams
        | undefined;

    const scope = getScope();

    if (!scope) {
        // Do NOT throw — the correct degraded behaviour is the base-language phrase, and
        // a 500 is strictly worse than an untranslated string. But this must be loud:
        // rendering base language silently IS the defect this package exists to correct,
        // and it is indistinguishable from a working page in any curl-shaped check.
        //
        // There is no request logger here, by definition. `console.warn` directly.
        warnOnceGlobal(CONSOLE_LOGGER, 'no-scope', NO_SCOPE_MESSAGE);
        return params ? interpolate(phrase, params, undefined) : phrase;
    }

    const bucket = scope.catalog[category || UNCATEGORIZED];
    const value = bucket?.[phrase];
    const hit = typeof value === 'string' && value.length > 0;
    const translated = hit ? (value as string) : phrase;

    if (!hit && scope.locale !== scope.baseLocale) {
        // A miss in the BASE locale is not a miss — the phrase is already in the base
        // language and there is nothing to look up. Queueing those would register every
        // phrase on every base-locale render.
        queueMiss(scope, phrase, category);
    }

    if (!params) return translated;

    // Re-issue the base SDK's unmatched-param warning against the REQUEST's logger. The
    // vendored `warnUnmatchedParams` reads a module-global `debugEnabled` this package
    // does not have, so the check is re-run here rather than dropped: it catches the
    // case where a framework's template compiler substituted `{name}` before Langsys saw
    // the text, which otherwise presents as a silently unsubstituted string.
    const unused = findUnusedParamKeys([translated], params);
    if (unused.length > 0) {
        scope.logger.warn(
            `t("${phrase}") received params with no matching placeholder: ${unused
                .map((k) => `%${k}%`)
                .join(', ')}. If you wrote {${unused[0]}} in markup, your framework's ` +
                `template compiler may have substituted it before Langsys saw the text — ` +
                `write %${unused[0]}% instead.`,
        );
    }

    return interpolate(translated, params, scope.locale);
};
