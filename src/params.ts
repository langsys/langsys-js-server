/**
 * Which supplied params matched no placeholder in the rendered text.
 *
 * **Local rather than imported, and deliberately so.** `langsys-js-typescript/pure`
 * exports nineteen of the twenty functions this package needs; this is the one it does
 * not, because in the core it is an internal of `warnUnmatchedParams` rather than public
 * API. It is safe to hold locally in a way none of the others would be: it feeds a
 * WARNING and never the id, so a divergence here costs a misleading log line, not a
 * re-keyed catalog. Every identity-bearing function comes from the subpath.
 *
 * Raised with the TS lane; if they export it, this file goes and the import moves.
 *
 * **It checks BOTH placeholder spellings, which the core's version does not.** The core
 * matched `{name}` only — correct while `{name}` was the only form it resolved. As of the
 * `/pure` subpath `interpolate` also substitutes `%name%` when the key is supplied, so a
 * `{name}`-only test now reports a param as unused that was in fact substituted, and the
 * warning tells the integrator to switch to the very syntax they already used. Checking
 * one form is not a smaller version of checking two; it is a wrong answer.
 */

import type { TranslateParams } from './types.js';

/** Escape a param key for literal use inside a `RegExp`. */
function escapeForRegExp(key: string): string {
    return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Param keys with no matching placeholder in any of `texts`.
 *
 * `{key}` is matched with optional inner whitespace and an ICU-aware terminator, so
 * `{count, plural, ...}` counts as a match for `count`. `%key%` is matched literally.
 */
export function findUnusedParamKeys(texts: string[], params?: TranslateParams): string[] {
    if (!params) return [];
    const keys = Object.keys(params);
    if (!keys.length || !texts.length) return keys;

    // NUL join, so a placeholder cannot be formed accidentally across two texts.
    const haystack = texts.join('\0');
    return keys.filter((key) => {
        const escaped = escapeForRegExp(key);
        const braced = new RegExp(`\\{\\s*${escaped}\\s*[,}]`);
        const percent = new RegExp(`%${escaped}%`);
        return !braced.test(haystack) && !percent.test(haystack);
    });
}
